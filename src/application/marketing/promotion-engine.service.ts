import { Prisma } from '@prisma/client';
import type { Promotion } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors';
import { emitEvent } from '../../shared/domain-events';
import { money, ZERO } from '../../shared/money';
import { logger } from '../../shared/logger';
import { auditService } from '../audit/audit.service';
import { consumerPush } from '../notifications/consumer-push.service';

/**
 * Promotion engine (§6, §7, §8).
 *
 * Promotions belong to one organisation and are only ever visible to customers
 * linked to it — a flash sale at one shop must never surface under another.
 * Redemption limits, budget and schedule are all enforced server-side; the
 * client only ever displays what the server says is currently claimable.
 */

export const PROMOTION_KINDS = [
  'DISCOUNT', 'CASHBACK', 'BOGO', 'HAPPY_HOUR', 'FLASH_SALE', 'MEMBER',
  'BIRTHDAY', 'SEASONAL', 'PRODUCT', 'SERVICE', 'BRANCH',
] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

interface Schedule {
  /** ISO weekdays, 1 = Monday. Empty/absent = every day. */
  days?: number[];
  from?: string; // "17:00"
  to?: string; // "19:00"
}

/** Is a time-windowed promotion (happy hour, flash sale) live right now? */
function withinSchedule(promotion: Promotion, now: Date): boolean {
  const schedule = promotion.schedule as Schedule | null;
  if (!schedule) return true;

  if (schedule.days?.length) {
    const isoDay = now.getDay() === 0 ? 7 : now.getDay();
    if (!schedule.days.includes(isoDay)) return false;
  }
  if (schedule.from && schedule.to) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [fh = 0, fm = 0] = schedule.from.split(':').map(Number);
    const [th = 23, tm = 59] = schedule.to.split(':').map(Number);
    const start = fh * 60 + fm;
    const end = th * 60 + tm;
    // A window that wraps midnight (22:00–02:00) is still one window.
    return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
  }
  return true;
}

interface AudienceRule {
  tiers?: string[];
  tags?: string[];
  segmentIds?: string[];
  newCustomersOnly?: boolean;
}

const view = (p: Promotion) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  kind: p.kind,
  discountType: p.discountType,
  discountValue: p.discountValue.toString(),
  minSpend: p.minSpend ? p.minSpend.toFixed(2) : null,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  imageUrl: p.imageUrl,
  terms: p.terms,
  maxPerCustomer: p.maxPerCustomer,
  schedule: p.schedule,
  branchId: p.branchId,
});

export const promotionEngine = {
  PROMOTION_KINDS,

  /** Promotions a specific customer can actually claim right now. */
  async availableFor(organizationId: string, customerId: string) {
    const now = new Date();
    const promotions = await prismaUnscoped.promotion.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { endsAt: 'asc' },
    });
    if (promotions.length === 0) return [];

    const [customer, loyalty, redemptions] = await Promise.all([
      prismaUnscoped.customer.findUnique({
        where: { id: customerId },
        select: { createdAt: true, totalOrders: true },
      }),
      prismaUnscoped.loyaltyAccount.findUnique({ where: { customerId }, select: { tier: true } }),
      prismaUnscoped.promotionRedemption.groupBy({
        by: ['promotionId'],
        where: { customerId, promotionId: { in: promotions.map((p) => p.id) } },
        _count: { _all: true },
      }),
    ]);

    return promotions
      .filter((p) => {
        if (!withinSchedule(p, now)) return false;
        if (p.maxRedemptions !== null && p.redemptionCount >= p.maxRedemptions) return false;
        if (p.budget && money(p.budgetSpent).greaterThanOrEqualTo(p.budget)) return false;

        const used = redemptions.find((r) => r.promotionId === p.id)?._count._all ?? 0;
        if (used >= p.maxPerCustomer) return false;

        const audience = p.audience as AudienceRule | null;
        if (audience?.tiers?.length && !audience.tiers.includes(loyalty?.tier ?? 'BRONZE')) return false;
        if (audience?.newCustomersOnly && (customer?.totalOrders ?? 0) > 0) return false;
        return true;
      })
      .map(view);
  },

  /**
   * Claim a promotion against a purchase. Everything that could over-spend the
   * campaign is checked *and* incremented under a guard, so two concurrent
   * checkouts can't both take the last redemption.
   */
  async redeem(params: {
    organizationId: string;
    promotionId: string;
    customerId: string;
    vhicasarId?: string | null;
    spendAmount: Prisma.Decimal | string | number;
    currency: string;
    orderId?: string;
    paymentId?: string;
  }) {
    const now = new Date();
    const promotion = await prismaUnscoped.promotion.findFirst({
      where: { id: params.promotionId, organizationId: params.organizationId },
    });
    if (!promotion) throw new NotFoundError('Promotion');
    if (promotion.status !== 'ACTIVE') throw new ConflictError('This promotion is not active.');
    if (promotion.startsAt > now || promotion.endsAt < now) {
      throw new ConflictError('This promotion is not running right now.');
    }
    if (!withinSchedule(promotion, now)) {
      throw new ConflictError('This promotion is outside its active hours.');
    }

    const spend = money(params.spendAmount);
    if (promotion.minSpend && spend.lessThan(promotion.minSpend)) {
      throw new AppError(
        'MIN_SPEND_NOT_MET',
        409,
        `Spend at least ${promotion.minSpend.toFixed(2)} to use this promotion.`
      );
    }

    const usedByCustomer = await prismaUnscoped.promotionRedemption.count({
      where: { promotionId: promotion.id, customerId: params.customerId },
    });
    if (usedByCustomer >= promotion.maxPerCustomer) {
      throw new ConflictError('You have already used this promotion.');
    }

    const benefit = this.calculateBenefit(promotion, spend);
    if (!benefit.greaterThan(ZERO)) throw new ConflictError('This promotion gives no benefit on this purchase.');

    // Guarded claim: only succeeds while the campaign still has headroom.
    const claimed = await prismaUnscoped.promotion.updateMany({
      where: {
        id: promotion.id,
        status: 'ACTIVE',
        ...(promotion.maxRedemptions !== null ? { redemptionCount: { lt: promotion.maxRedemptions } } : {}),
      },
      data: { redemptionCount: { increment: 1 }, budgetSpent: { increment: benefit } },
    });
    if (claimed.count !== 1) throw new ConflictError('This promotion has been fully claimed.');

    // Over budget after this claim? Close it so nobody else starts a checkout
    // that would be refused at the end.
    const fresh = await prismaUnscoped.promotion.findUnique({ where: { id: promotion.id } });
    if (fresh?.budget && money(fresh.budgetSpent).greaterThanOrEqualTo(fresh.budget)) {
      await prismaUnscoped.promotion.update({ where: { id: promotion.id }, data: { status: 'ENDED' } });
    }

    const redemption = await prismaUnscoped.promotionRedemption.create({
      data: {
        organizationId: params.organizationId,
        promotionId: promotion.id,
        customerId: params.customerId,
        vhicasarId: params.vhicasarId ?? null,
        orderId: params.orderId ?? null,
        paymentId: params.paymentId ?? null,
        benefitAmount: benefit,
        currency: params.currency,
      },
    });

    await emitEvent({
      name: 'PromotionRedeemed',
      aggregateType: 'Promotion',
      aggregateId: promotion.id,
      payload: {
        customerId: params.customerId,
        benefit: benefit.toFixed(2),
        currency: params.currency,
        kind: promotion.kind,
      },
      organizationId: params.organizationId,
    });

    return {
      redemptionId: redemption.id,
      promotionId: promotion.id,
      benefit: benefit.toFixed(2),
      currency: params.currency,
      kind: promotion.kind,
    };
  },

  /** What the customer saves / gets back. Cashback is credited, not deducted. */
  calculateBenefit(promotion: Promotion, spend: Prisma.Decimal): Prisma.Decimal {
    const value = money(promotion.discountValue);
    let benefit =
      promotion.discountType === 'PERCENTAGE' ? spend.mul(value).div(100) : value;
    // Never give back more than was spent.
    if (benefit.greaterThan(spend)) benefit = spend;
    return money(benefit.toFixed(2));
  },

  // ---- Merchant management ----

  async list(organizationId: string) {
    const rows = await prisma.promotion.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => ({
      ...view(p),
      status: p.status,
      budget: p.budget?.toFixed(2) ?? null,
      budgetSpent: p.budgetSpent.toFixed(2),
      redemptionCount: p.redemptionCount,
      maxRedemptions: p.maxRedemptions,
      audience: p.audience,
      notifyAt: p.notifyAt,
      notifiedAt: p.notifiedAt,
    }));
  },

  async upsert(
    organizationId: string,
    dto: Record<string, unknown> & { id?: string; name: string; startsAt: Date; endsAt: Date }
  ) {
    const data = {
      organizationId,
      name: dto.name,
      description: (dto.description as string) ?? null,
      kind: (dto.kind as string) ?? 'DISCOUNT',
      discountType: (dto.discountType as 'PERCENTAGE' | 'FIXED_AMOUNT') ?? 'PERCENTAGE',
      discountValue: (dto.discountValue as number) ?? 0,
      status: (dto.status as never) ?? 'SCHEDULED',
      branchId: (dto.branchId as string) ?? null,
      budget: (dto.budget as number) ?? null,
      audience: (dto.audience ?? undefined) as Prisma.InputJsonValue | undefined,
      minSpend: (dto.minSpend as number) ?? null,
      maxRedemptions: (dto.maxRedemptions as number) ?? null,
      maxPerCustomer: (dto.maxPerCustomer as number) ?? 1,
      schedule: (dto.schedule ?? undefined) as Prisma.InputJsonValue | undefined,
      notifyAt: (dto.notifyAt as Date) ?? null,
      imageUrl: (dto.imageUrl as string) ?? null,
      terms: (dto.terms as string) ?? null,
      appliesTo: (dto.appliesTo ?? undefined) as Prisma.InputJsonValue | undefined,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
    };

    const promotion = dto.id
      ? await prisma.promotion.update({ where: { id: dto.id }, data })
      : await prisma.promotion.create({ data });

    await auditService.record({
      action: dto.id ? 'promotion.updated' : 'promotion.created',
      entityType: 'Promotion',
      entityId: promotion.id,
      after: { name: promotion.name, kind: promotion.kind, status: promotion.status },
    });
    if (!dto.id) {
      await emitEvent({
        name: 'PromotionCreated',
        aggregateType: 'Promotion',
        aggregateId: promotion.id,
        payload: { name: promotion.name, kind: promotion.kind },
        organizationId,
      });
    }
    return promotion;
  },

  async setStatus(id: string, status: 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'ENDED') {
    const updated = await prisma.promotion.updateMany({ where: { id }, data: { status } });
    if (updated.count === 0) throw new NotFoundError('Promotion');
    return { id, status };
  },

  /** Analytics for the business (§14). */
  async analytics(organizationId: string, promotionId?: string) {
    const where = { organizationId, ...(promotionId ? { promotionId } : {}) };
    const [agg, byPromotion, uniqueCustomers] = await Promise.all([
      prismaUnscoped.promotionRedemption.aggregate({
        where,
        _count: { _all: true },
        _sum: { benefitAmount: true },
      }),
      prismaUnscoped.promotionRedemption.groupBy({
        by: ['promotionId'],
        where,
        _count: { _all: true },
        _sum: { benefitAmount: true },
      }),
      prismaUnscoped.promotionRedemption.findMany({
        where,
        select: { customerId: true },
        distinct: ['customerId'],
      }),
    ]);

    const promoIds = byPromotion.map((p) => p.promotionId);
    const promos = promoIds.length
      ? await prismaUnscoped.promotion.findMany({
          where: { id: { in: promoIds } },
          select: { id: true, name: true, kind: true, budget: true, budgetSpent: true },
        })
      : [];

    return {
      totalRedemptions: agg._count._all,
      totalBenefitGiven: (agg._sum.benefitAmount ?? ZERO).toFixed(2),
      uniqueCustomers: uniqueCustomers.length,
      byPromotion: byPromotion.map((r) => {
        const p = promos.find((x) => x.id === r.promotionId);
        return {
          promotionId: r.promotionId,
          name: p?.name ?? '—',
          kind: p?.kind ?? null,
          redemptions: r._count._all,
          benefitGiven: (r._sum.benefitAmount ?? ZERO).toFixed(2),
          budget: p?.budget?.toFixed(2) ?? null,
          budgetSpent: p?.budgetSpent.toFixed(2) ?? '0.00',
        };
      }),
    };
  },

  /**
   * Push scheduled promotion notifications (§7). The payload deep-links
   * straight to the business and promotion so the customer never has to search.
   */
  async sendDueNotifications(): Promise<number> {
    const now = new Date();
    const due = await prismaUnscoped.promotion.findMany({
      where: {
        status: 'ACTIVE',
        notifyAt: { lte: now },
        notifiedAt: null,
        endsAt: { gte: now },
      },
      take: 20,
    });

    let sent = 0;
    for (const promotion of due) {
      // Claim it first so a second worker can't send the same push twice.
      const claimed = await prismaUnscoped.promotion.updateMany({
        where: { id: promotion.id, notifiedAt: null },
        data: { notifiedAt: now },
      });
      if (claimed.count !== 1) continue;

      try {
        const [org, links] = await Promise.all([
          prismaUnscoped.organization.findUnique({
            where: { id: promotion.organizationId },
            select: { name: true },
          }),
          prismaUnscoped.customerLink.findMany({
            where: { organizationId: promotion.organizationId, status: 'ACTIVE' },
            select: { vhicasarId: true },
          }),
        ]);

        // Respect each customer's per-business notification preference.
        const prefs = await prismaUnscoped.customerBusinessPreference.findMany({
          where: {
            organizationId: promotion.organizationId,
            vhicasarId: { in: links.map((l) => l.vhicasarId) },
          },
          select: { vhicasarId: true, notifyPromotions: true },
        });
        const optedOut = new Set(prefs.filter((p) => !p.notifyPromotions).map((p) => p.vhicasarId));

        for (const link of links) {
          if (optedOut.has(link.vhicasarId)) continue;
          await consumerPush.sendToIdentity(link.vhicasarId, {
            title: `${org?.name ?? 'A business'}: ${promotion.name}`,
            body: promotion.description ?? 'Tap to see this offer.',
            data: {
              type: 'promotion',
              organizationId: promotion.organizationId,
              promotionId: promotion.id,
              // The app routes straight here — no manual searching (§7).
              deeplink: `vhicasar://business/${promotion.organizationId}/promotion/${promotion.id}`,
            },
          });
        }

        await prismaUnscoped.customerLink.updateMany({
          where: { organizationId: promotion.organizationId, status: 'ACTIVE' },
          data: { unreadPromotions: { increment: 1 } },
        });

        await emitEvent({
          name: 'PromotionPublished',
          aggregateType: 'Promotion',
          aggregateId: promotion.id,
          payload: { name: promotion.name, recipients: links.length - optedOut.size },
          organizationId: promotion.organizationId,
        });
        sent += 1;
      } catch (err) {
        logger.error({ err, promotionId: promotion.id }, 'promotion notification failed');
      }
    }
    return sent;
  },
};

let notifyTimer: NodeJS.Timeout | null = null;

/** Poll for promotions whose scheduled push time has arrived. */
export function startPromotionNotifier(intervalMs = 60_000): void {
  if (notifyTimer) return;
  const tick = async () => {
    try {
      const n = await promotionEngine.sendDueNotifications();
      if (n > 0) logger.info({ promotions: n }, 'promotion notifications sent');
    } catch (err) {
      logger.error({ err }, 'promotion notifier tick failed');
    }
  };
  notifyTimer = setInterval(() => void tick(), intervalMs);
  if (typeof notifyTimer.unref === 'function') notifyTimer.unref();
  logger.info(`📣 Promotion notifier started (${intervalMs}ms interval)`);
}
