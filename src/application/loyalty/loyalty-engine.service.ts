import { Prisma } from '@prisma/client';
import type { LoyaltyRule, LoyaltyTrigger } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { emitEvent } from '../../shared/domain-events';
import { money, ZERO } from '../../shared/money';
import { auditService } from '../audit/audit.service';

/**
 * Loyalty engine (§5).
 *
 * Loyalty is an independent engine: a purchase earns points because the
 * business has a *rule* for that trigger, not because it went through a
 * particular payment rail. Vhicasar Pay is simply one trigger among POS sales,
 * orders, bookings, invoices, card, transfer, cash, campaigns and referrals.
 *
 * Business (per-org) points live on `LoyaltyAccount` and are entirely separate
 * from the platform-wide `RewardAccount` — a customer earning at one shop must
 * never spend those points at another.
 */

export interface AwardContext {
  organizationId: string;
  customerId: string;
  trigger: LoyaltyTrigger;
  /** Qualifying spend in major units. Ignored for flat-point rules. */
  amount?: Prisma.Decimal | string | number | null;
  currency?: string;
  branchId?: string | null;
  /** Product / category ids the spend covered, for eligibility filtering. */
  productIds?: string[];
  categoryIds?: string[];
  /** Idempotency anchor — one award per source document. */
  sourceType?: string;
  sourceId?: string;
  note?: string;
}

const TIER_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] as const;

/** Does this rule apply to what was actually bought? */
function matchesEligibility(rule: LoyaltyRule, ctx: AwardContext): boolean {
  const eligibility = rule.eligibility as { scope?: string; ids?: string[] } | null;
  if (!eligibility || !eligibility.scope || eligibility.scope === 'ALL') return true;
  const ids = eligibility.ids ?? [];
  if (ids.length === 0) return true;
  if (eligibility.scope === 'PRODUCTS') return (ctx.productIds ?? []).some((id) => ids.includes(id));
  if (eligibility.scope === 'CATEGORIES') return (ctx.categoryIds ?? []).some((id) => ids.includes(id));
  return true;
}

function withinWindow(rule: LoyaltyRule, now: Date): boolean {
  if (rule.startsAt && rule.startsAt > now) return false;
  if (rule.endsAt && rule.endsAt < now) return false;
  return true;
}

export const loyaltyEngine = {
  /**
   * Award points for a business event. Returns null when nothing qualified —
   * callers treat that as normal, not an error, because most events won't match
   * a rule.
   *
   * Safe to call from anywhere: it never throws for business reasons, so a
   * loyalty misconfiguration can't block a sale from completing.
   */
  async award(ctx: AwardContext): Promise<{ points: number; balance: number; tier: string | null } | null> {
    const program = await prismaUnscoped.loyaltyProgram.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    if (!program || !program.isActive) return null;

    // One award per source document, so a retried webhook or a re-saved order
    // can't mint points twice.
    if (ctx.sourceType && ctx.sourceId) {
      const already = await prismaUnscoped.loyaltyTransaction.findFirst({
        where: {
          account: { customerId: ctx.customerId },
          referenceType: ctx.sourceType,
          referenceId: ctx.sourceId,
          type: 'EARN',
        },
        select: { id: true },
      });
      if (already) return null;
    }

    const now = new Date();
    const rules = await prismaUnscoped.loyaltyRule.findMany({
      where: { organizationId: ctx.organizationId, trigger: ctx.trigger, isActive: true },
      orderBy: { priority: 'desc' },
    });

    const account = await this.getOrCreateAccount(program.id, ctx.customerId);
    const amount = ctx.amount != null ? money(ctx.amount) : ZERO;

    let points = 0;
    const applied: string[] = [];

    for (const rule of rules) {
      if (!withinWindow(rule, now)) continue;
      if (rule.branchId && rule.branchId !== ctx.branchId) continue;
      if (rule.tier && rule.tier !== account.tier) continue;
      if (rule.minSpend && amount.lessThan(rule.minSpend)) continue;
      if (!matchesEligibility(rule, ctx)) continue;

      let earned = 0;
      if (rule.flatPoints) earned += rule.flatPoints;
      if (rule.pointsPerAmount && amount.greaterThan(ZERO)) {
        earned += Math.floor(Number(amount.mul(rule.pointsPerAmount).toFixed(4)));
      }
      if (rule.multiplier) earned = Math.floor(earned * Number(rule.multiplier));

      if (rule.maxPointsPerDay) {
        const earnedToday = await this.pointsEarnedToday(account.id);
        earned = Math.max(0, Math.min(earned, rule.maxPointsPerDay - earnedToday));
      }
      if (earned > 0) {
        points += earned;
        applied.push(rule.name);
      }
    }

    // No explicit rule for this trigger? Fall back to the programme's base rate
    // for spend-shaped events, so a business that never configures rules still
    // has a working loyalty scheme.
    if (rules.length === 0 && amount.greaterThan(ZERO) && SPEND_TRIGGERS.has(ctx.trigger)) {
      points = Math.floor(Number(amount.mul(program.pointsPerAmount).toFixed(4)));
      if (points > 0) applied.push('Base rate');
    }

    if (points <= 0) return null;

    const updated = await prismaUnscoped.loyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { increment: points } },
    });
    await prismaUnscoped.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        type: 'EARN',
        points,
        referenceType: ctx.sourceType ?? null,
        referenceId: ctx.sourceId ?? null,
        note: ctx.note ?? (applied.join(' + ') || `${ctx.trigger} reward`),
      },
    });

    const tier = await this.recalculateTier(account.id, updated.balance);

    await emitEvent({
      name: 'LoyaltyAwarded',
      aggregateType: 'LoyaltyAccount',
      aggregateId: account.id,
      payload: {
        customerId: ctx.customerId,
        points,
        balance: updated.balance,
        trigger: ctx.trigger,
        rules: applied,
      },
      organizationId: ctx.organizationId,
    });

    return { points, balance: updated.balance, tier };
  },

  /** Spend points. Guarded so two concurrent redemptions can't overdraw. */
  async redeem(organizationId: string, customerId: string, points: number, note?: string) {
    if (!Number.isInteger(points) || points <= 0) {
      throw new ValidationError('Enter a whole number of points to redeem');
    }
    const program = await prismaUnscoped.loyaltyProgram.findUnique({ where: { organizationId } });
    if (!program?.isActive) throw new NotFoundError('Loyalty programme');

    const account = await prismaUnscoped.loyaltyAccount.findUnique({ where: { customerId } });
    if (!account) throw new NotFoundError('Loyalty account');

    const claimed = await prismaUnscoped.loyaltyAccount.updateMany({
      where: { id: account.id, balance: { gte: points } },
      data: { balance: { decrement: points } },
    });
    if (claimed.count !== 1) throw new ConflictError('Not enough points to redeem');

    await prismaUnscoped.loyaltyTransaction.create({
      data: { accountId: account.id, type: 'REDEEM', points: -points, note: note ?? 'Points redeemed' },
    });

    const value = money(points).mul(program.redeemRate);
    const fresh = await prismaUnscoped.loyaltyAccount.findUnique({ where: { id: account.id } });

    await emitEvent({
      name: 'LoyaltyRedeemed',
      aggregateType: 'LoyaltyAccount',
      aggregateId: account.id,
      payload: { customerId, points, value: value.toFixed(2) },
      organizationId,
    });

    return { points, value: value.toFixed(2), balance: fresh?.balance ?? 0 };
  },

  async getOrCreateAccount(programId: string, customerId: string) {
    const existing = await prismaUnscoped.loyaltyAccount.findUnique({ where: { customerId } });
    if (existing) return existing;
    return prismaUnscoped.loyaltyAccount.create({
      data: { programId, customerId, tier: 'BRONZE' },
    });
  },

  async pointsEarnedToday(accountId: string): Promise<number> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const agg = await prismaUnscoped.loyaltyTransaction.aggregate({
      where: { accountId, type: 'EARN', createdAt: { gte: start } },
      _sum: { points: true },
    });
    return agg._sum.points ?? 0;
  },

  /** Tier from lifetime balance thresholds configured on the programme. */
  async recalculateTier(accountId: string, balance: number): Promise<string | null> {
    const account = await prismaUnscoped.loyaltyAccount.findUnique({
      where: { id: accountId },
      select: { tier: true, program: { select: { id: true, organizationId: true } } },
    });
    if (!account) return null;

    const tiers = await prismaUnscoped.loyaltyRule.findMany({
      where: { programId: account.program.id, trigger: 'MANUAL', tier: { not: null }, isActive: true },
      select: { tier: true, flatPoints: true },
    });
    // Thresholds are expressed as MANUAL rules carrying a tier + point floor;
    // fall back to sensible defaults when a business hasn't defined any.
    const thresholds = tiers.length
      ? tiers.map((t) => ({ tier: t.tier as string, min: t.flatPoints ?? 0 }))
      : [
          { tier: 'BRONZE', min: 0 },
          { tier: 'SILVER', min: 1000 },
          { tier: 'GOLD', min: 5000 },
          { tier: 'PLATINUM', min: 20000 },
        ];
    thresholds.sort((a, b) => b.min - a.min);
    const next = thresholds.find((t) => balance >= t.min)?.tier ?? 'BRONZE';

    if (next !== account.tier) {
      await prismaUnscoped.loyaltyAccount.update({ where: { id: accountId }, data: { tier: next } });
      await emitEvent({
        name: 'LoyaltyTierChanged',
        aggregateType: 'LoyaltyAccount',
        aggregateId: accountId,
        payload: { from: account.tier, to: next, balance },
        organizationId: account.program.organizationId,
      });
    }
    return next;
  },

  // ---- Rule management (merchant side, tenant-scoped) ----

  async listRules(organizationId: string) {
    return prisma.loyaltyRule.findMany({
      where: { organizationId },
      orderBy: [{ trigger: 'asc' }, { priority: 'desc' }],
    });
  },

  async upsertRule(
    organizationId: string,
    dto: {
      id?: string;
      name: string;
      trigger: LoyaltyTrigger;
      pointsPerAmount?: number;
      flatPoints?: number;
      multiplier?: number;
      minSpend?: number;
      maxPointsPerDay?: number;
      eligibility?: Record<string, unknown>;
      tier?: string;
      branchId?: string;
      startsAt?: Date;
      endsAt?: Date;
      priority?: number;
      isActive?: boolean;
    }
  ) {
    const program = await prisma.loyaltyProgram.findUnique({ where: { organizationId } });
    if (!program) throw new NotFoundError('Loyalty programme — create one before adding rules');

    const data = {
      organizationId,
      programId: program.id,
      name: dto.name,
      trigger: dto.trigger,
      pointsPerAmount: dto.pointsPerAmount ?? null,
      flatPoints: dto.flatPoints ?? null,
      multiplier: dto.multiplier ?? null,
      minSpend: dto.minSpend ?? null,
      maxPointsPerDay: dto.maxPointsPerDay ?? null,
      eligibility: (dto.eligibility ?? undefined) as Prisma.InputJsonValue | undefined,
      tier: dto.tier ?? null,
      branchId: dto.branchId ?? null,
      startsAt: dto.startsAt ?? null,
      endsAt: dto.endsAt ?? null,
      priority: dto.priority ?? 0,
      isActive: dto.isActive ?? true,
    };

    const rule = dto.id
      ? await prisma.loyaltyRule.update({ where: { id: dto.id }, data })
      : await prisma.loyaltyRule.create({ data });

    await auditService.record({
      action: dto.id ? 'loyalty_rule.updated' : 'loyalty_rule.created',
      entityType: 'LoyaltyRule',
      entityId: rule.id,
      after: { name: rule.name, trigger: rule.trigger },
    });
    return rule;
  },

  async deleteRule(id: string) {
    const removed = await prisma.loyaltyRule.deleteMany({ where: { id } });
    if (removed.count === 0) throw new NotFoundError('Loyalty rule');
  },

  /** Customer-facing statement for one business. */
  async statement(customerId: string, opts: { cursor?: string; limit: number }) {
    const account = await prismaUnscoped.loyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true, balance: true, tier: true, program: { select: { name: true, redeemRate: true } } },
    });
    if (!account) return { balance: 0, tier: null, items: [], nextCursor: null };

    const rows = await prismaUnscoped.loyaltyTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;

    return {
      balance: account.balance,
      tier: account.tier,
      programName: account.program?.name ?? null,
      pointValue: account.program?.redeemRate.toString() ?? null,
      items: items.map((t) => ({
        id: t.id,
        type: t.type,
        points: t.points,
        note: t.note,
        createdAt: t.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },
};

/** Triggers whose points scale with money spent. */
const SPEND_TRIGGERS = new Set<LoyaltyTrigger>([
  'POS_SALE',
  'ORDER',
  'BOOKING',
  'INVOICE_PAYMENT',
  'WALLET_PAYMENT',
  'CARD_PAYMENT',
  'BANK_TRANSFER',
  'CASH_SALE',
]);

export { TIER_ORDER };
