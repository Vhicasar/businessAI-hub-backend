import { Prisma } from '@prisma/client';
import type { RewardCampaign } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { money, ZERO } from '../../shared/money';
import { emitEvent } from '../../shared/domain-events';
import { logger } from '../../shared/logger';
import { auditService } from '../audit/audit.service';
import { walletBuckets } from '../payments/wallet-buckets.service';

/**
 * Platform reward campaigns (§11, §13, §15).
 *
 * These pay customers to pay with the Vhicasar app — real platform money, so
 * every guard matters: budgets, per-customer caps, eligibility, and abuse
 * detection. A reward that trips the abuse checks is held for review rather
 * than paid, because clawing money back afterwards rarely works.
 */

const decimal = (v: Prisma.Decimal | null | undefined) => (v ?? ZERO).toFixed(2);

interface AbuseSignal {
  code: string;
  detail?: string;
}

export const rewardCampaigns = {
  // ---- Admin management (§13) ----

  async list() {
    const rows = await prismaUnscoped.rewardCampaign.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      rewardAmount: c.rewardAmount ? decimal(c.rewardAmount) : null,
      rewardPercent: c.rewardPercent ? c.rewardPercent.toString() : null,
      maxRewardPerTxn: c.maxRewardPerTxn ? decimal(c.maxRewardPerTxn) : null,
      minSpend: decimal(c.minSpend),
      maxRewardsPerDay: c.maxRewardsPerDay,
      maxRewardsPerMonth: c.maxRewardsPerMonth,
      budget: c.budget ? decimal(c.budget) : null,
      budgetSpent: decimal(c.budgetSpent),
      currency: c.currency,
      targetBucket: c.targetBucket,
      rewardExpiryDays: c.rewardExpiryDays,
      fundingSource: c.fundingSource,
      eligibleOrganizationIds: c.eligibleOrganizationIds,
      eligibleCategories: c.eligibleCategories,
      eligibleCountries: c.eligibleCountries,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
    }));
  },

  async upsert(dto: Record<string, unknown> & { id?: string; name: string; currency: string; startsAt: Date }) {
    if (!dto.rewardAmount && !dto.rewardPercent) {
      throw new ValidationError('Set a reward amount or a reward percentage');
    }
    const data = {
      name: dto.name,
      description: (dto.description as string) ?? null,
      status: (dto.status as never) ?? 'DRAFT',
      rewardAmount: (dto.rewardAmount as number) ?? null,
      rewardPercent: (dto.rewardPercent as number) ?? null,
      maxRewardPerTxn: (dto.maxRewardPerTxn as number) ?? null,
      minSpend: (dto.minSpend as number) ?? 0,
      maxRewardsPerDay: (dto.maxRewardsPerDay as number) ?? null,
      maxRewardsPerMonth: (dto.maxRewardsPerMonth as number) ?? null,
      budget: (dto.budget as number) ?? null,
      currency: dto.currency.toUpperCase(),
      eligibleOrganizationIds: (dto.eligibleOrganizationIds as string[]) ?? [],
      eligibleCategories: (dto.eligibleCategories as string[]) ?? [],
      eligibleCountries: (dto.eligibleCountries as string[]) ?? [],
      targetBucket: (dto.targetBucket as never) ?? 'REWARD',
      rewardExpiryDays: (dto.rewardExpiryDays as number) ?? null,
      fundingSource: (dto.fundingSource as string) ?? 'PLATFORM',
      startsAt: dto.startsAt,
      endsAt: (dto.endsAt as Date) ?? null,
    };

    const campaign = dto.id
      ? await prismaUnscoped.rewardCampaign.update({ where: { id: dto.id }, data })
      : await prismaUnscoped.rewardCampaign.create({ data });

    await auditService.record({
      action: dto.id ? 'reward_campaign.updated' : 'reward_campaign.created',
      entityType: 'RewardCampaign',
      entityId: campaign.id,
      after: { name: campaign.name, status: campaign.status },
      actorType: 'SYSTEM',
    });
    return campaign;
  },

  async setStatus(id: string, status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'SUSPENDED') {
    const campaign = await prismaUnscoped.rewardCampaign.update({ where: { id }, data: { status } });
    await auditService.record({
      action: `reward_campaign.${status.toLowerCase()}`,
      entityType: 'RewardCampaign',
      entityId: id,
      actorType: 'SYSTEM',
    });
    return { id: campaign.id, status: campaign.status };
  },

  // ---- Granting (§11) ----

  /**
   * Pay out a reward for a qualifying payment. Called from the PaymentCompleted
   * subscriber, so it must be idempotent per payment and must never throw into
   * the payment path.
   */
  async grantForPayment(params: {
    vhicasarId: string;
    organizationId: string | null;
    paymentId: string;
    amount: Prisma.Decimal | string | number;
    currency: string;
    deviceId?: string | null;
  }): Promise<{ campaignId: string; reward: string; status: string } | null> {
    const spend = money(params.amount);
    const currency = params.currency.toUpperCase();
    const now = new Date();

    const campaign = await this.findEligibleCampaign(params.organizationId, currency, spend, now);
    if (!campaign) return null;

    const idempotencyKey = `reward:${campaign.id}:${params.paymentId}`;
    const existing = await prismaUnscoped.rewardGrant.findUnique({ where: { idempotencyKey } });
    if (existing) return null;

    // Per-customer frequency caps.
    if (!(await this.withinCustomerCaps(campaign, params.vhicasarId, now))) return null;

    let reward = campaign.rewardAmount
      ? money(campaign.rewardAmount)
      : spend.mul(campaign.rewardPercent ?? 0).div(100);
    if (campaign.maxRewardPerTxn && reward.greaterThan(campaign.maxRewardPerTxn)) {
      reward = money(campaign.maxRewardPerTxn);
    }
    reward = money(reward.toFixed(2));
    if (!reward.greaterThan(ZERO)) return null;

    // Budget guard: claim the spend before paying, so concurrent grants can't
    // overshoot the campaign's funding.
    if (campaign.budget) {
      const claimed = await prismaUnscoped.rewardCampaign.updateMany({
        where: { id: campaign.id, status: 'ACTIVE', budgetSpent: { lte: campaign.budget.minus(reward) } },
        data: { budgetSpent: { increment: reward } },
      });
      if (claimed.count !== 1) {
        await this.setStatus(campaign.id, 'ENDED');
        return null;
      }
    } else {
      await prismaUnscoped.rewardCampaign.update({
        where: { id: campaign.id },
        data: { budgetSpent: { increment: reward } },
      });
    }

    const signals = await this.detectAbuse(campaign, params, now);
    const held = signals.length > 0;

    const grant = await prismaUnscoped.rewardGrant.create({
      data: {
        campaignId: campaign.id,
        vhicasarId: params.vhicasarId,
        organizationId: params.organizationId,
        paymentId: params.paymentId,
        spendAmount: spend,
        rewardAmount: reward,
        currency,
        status: held ? 'PENDING_REVIEW' : 'GRANTED',
        riskScore: held ? Math.min(100, signals.length * 30) : 0,
        reviewNotes: held ? signals.map((s) => s.code).join(', ') : null,
        idempotencyKey,
        expiresAt: campaign.rewardExpiryDays
          ? new Date(now.getTime() + campaign.rewardExpiryDays * 864e5)
          : null,
      },
    });

    if (held) {
      // Money is reserved against the budget but not paid; a reviewer releases
      // or rejects it. Paying first and clawing back rarely works.
      await emitEvent({
        name: 'RewardHeldForReview',
        aggregateType: 'RewardGrant',
        aggregateId: grant.id,
        payload: { vhicasarId: params.vhicasarId, reward: reward.toFixed(2), signals: signals.map((s) => s.code) },
        organizationId: params.organizationId,
      });
      return { campaignId: campaign.id, reward: reward.toFixed(2), status: 'PENDING_REVIEW' };
    }

    await this.settleGrant(grant.id);
    return { campaignId: campaign.id, reward: reward.toFixed(2), status: 'GRANTED' };
  },

  /** Credit the customer's wallet for an approved grant. */
  async settleGrant(grantId: string) {
    const grant = await prismaUnscoped.rewardGrant.findUnique({
      where: { id: grantId },
      include: { campaign: { select: { targetBucket: true, name: true } } },
    });
    if (!grant || grant.settledAt) return;

    await walletBuckets.credit({
      vhicasarId: grant.vhicasarId,
      currency: grant.currency,
      amount: grant.rewardAmount,
      bucket: grant.campaign.targetBucket,
      description: `Reward: ${grant.campaign.name}`,
      idempotencyKey: `reward-grant:${grant.id}`,
      organizationId: grant.organizationId,
    });

    await prismaUnscoped.rewardGrant.update({
      where: { id: grant.id },
      data: { status: 'GRANTED', settledAt: new Date() },
    });
    await emitEvent({
      name: 'RewardGranted',
      aggregateType: 'RewardGrant',
      aggregateId: grant.id,
      payload: {
        vhicasarId: grant.vhicasarId,
        amount: grant.rewardAmount.toFixed(2),
        currency: grant.currency,
        bucket: grant.campaign.targetBucket,
      },
      organizationId: grant.organizationId,
    });
  },

  /** Reviewer decision on a held reward. */
  async reviewGrant(grantId: string, action: 'APPROVE' | 'REJECT', notes?: string) {
    const grant = await prismaUnscoped.rewardGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new NotFoundError('Reward grant');
    if (grant.status !== 'PENDING_REVIEW') throw new ConflictError('This reward has already been decided.');

    if (action === 'APPROVE') {
      await prismaUnscoped.rewardGrant.update({ where: { id: grantId }, data: { reviewNotes: notes ?? null } });
      await this.settleGrant(grantId);
    } else {
      await prismaUnscoped.rewardGrant.update({
        where: { id: grantId },
        data: { status: 'REJECTED', reviewNotes: notes ?? null, settledAt: new Date() },
      });
      // Give the budget back — the money was never paid out.
      await prismaUnscoped.rewardCampaign.update({
        where: { id: grant.campaignId },
        data: { budgetSpent: { decrement: grant.rewardAmount } },
      });
    }
    await auditService.record({
      action: `reward_grant.${action.toLowerCase()}`,
      entityType: 'RewardGrant',
      entityId: grantId,
      after: { notes },
      actorType: 'SYSTEM',
    });
    return { id: grantId, status: action === 'APPROVE' ? 'GRANTED' : 'REJECTED' };
  },

  async findEligibleCampaign(
    organizationId: string | null,
    currency: string,
    spend: Prisma.Decimal,
    now: Date
  ): Promise<RewardCampaign | null> {
    const candidates = await prismaUnscoped.rewardCampaign.findMany({
      where: {
        status: 'ACTIVE',
        currency,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
        minSpend: { lte: spend },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (candidates.length === 0) return null;

    let orgCategory: string | null = null;
    let orgCountry: string | null = null;
    if (organizationId) {
      const [profile, org] = await Promise.all([
        prismaUnscoped.businessProfile.findUnique({
          where: { organizationId },
          select: { category: true },
        }),
        prismaUnscoped.organization.findUnique({ where: { id: organizationId }, select: { country: true } }),
      ]);
      orgCategory = profile?.category ?? null;
      orgCountry = org?.country ?? null;
    }

    // Empty eligibility arrays mean "everyone qualifies".
    return (
      candidates.find((c) => {
        if (c.eligibleOrganizationIds.length && (!organizationId || !c.eligibleOrganizationIds.includes(organizationId))) {
          return false;
        }
        if (c.eligibleCategories.length && (!orgCategory || !c.eligibleCategories.includes(orgCategory))) return false;
        if (c.eligibleCountries.length && (!orgCountry || !c.eligibleCountries.includes(orgCountry))) return false;
        if (c.budget && money(c.budgetSpent).greaterThanOrEqualTo(c.budget)) return false;
        return true;
      }) ?? null
    );
  },

  async withinCustomerCaps(campaign: RewardCampaign, vhicasarId: string, now: Date): Promise<boolean> {
    if (campaign.maxRewardsPerDay) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const today = await prismaUnscoped.rewardGrant.count({
        where: { campaignId: campaign.id, vhicasarId, createdAt: { gte: dayStart }, status: { not: 'REJECTED' } },
      });
      if (today >= campaign.maxRewardsPerDay) return false;
    }
    if (campaign.maxRewardsPerMonth) {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const month = await prismaUnscoped.rewardGrant.count({
        where: { campaignId: campaign.id, vhicasarId, createdAt: { gte: monthStart }, status: { not: 'REJECTED' } },
      });
      if (month >= campaign.maxRewardsPerMonth) return false;
    }
    return true;
  },

  /**
   * Reward-farming detection (§15). Looks for the patterns that show someone is
   * cycling money to harvest rewards rather than genuinely shopping.
   */
  async detectAbuse(
    campaign: RewardCampaign,
    params: { vhicasarId: string; organizationId: string | null; deviceId?: string | null },
    now: Date
  ): Promise<AbuseSignal[]> {
    const signals: AbuseSignal[] = [];
    const hourAgo = new Date(now.getTime() - 3600_000);
    const dayAgo = new Date(now.getTime() - 864e5);

    const [recentGrants, sameMerchantToday, identity] = await Promise.all([
      prismaUnscoped.rewardGrant.count({
        where: { vhicasarId: params.vhicasarId, createdAt: { gte: hourAgo } },
      }),
      params.organizationId
        ? prismaUnscoped.rewardGrant.count({
            where: {
              vhicasarId: params.vhicasarId,
              organizationId: params.organizationId,
              createdAt: { gte: dayAgo },
            },
          })
        : Promise.resolve(0),
      prismaUnscoped.vhicasarId.findUnique({
        where: { id: params.vhicasarId },
        select: { createdAt: true, kycLevel: true },
      }),
    ]);

    if (recentGrants >= 5) signals.push({ code: 'HIGH_VELOCITY', detail: `${recentGrants} rewards in an hour` });
    if (sameMerchantToday >= 5) {
      signals.push({ code: 'MERCHANT_CYCLING', detail: `${sameMerchantToday} at one merchant today` });
    }
    if (identity && identity.createdAt > dayAgo && campaign.rewardAmount) {
      signals.push({ code: 'NEW_ACCOUNT', detail: 'Account under 24h old' });
    }

    // Several accounts claiming from one device is the clearest farming signal.
    if (params.deviceId) {
      const devices = await prismaUnscoped.device.findMany({
        where: { deviceId: params.deviceId },
        select: { vhicasarId: true },
      });
      const distinct = new Set(devices.map((d) => d.vhicasarId));
      if (distinct.size > 2) {
        signals.push({ code: 'SHARED_DEVICE', detail: `${distinct.size} accounts on one device` });
      }
    }
    return signals;
  },

  // ---- Analytics (§13, §14) ----

  async analytics(campaignId?: string) {
    const where = campaignId ? { campaignId } : {};
    const [agg, byStatus, uniqueCustomers, byOrg] = await Promise.all([
      prismaUnscoped.rewardGrant.aggregate({
        where,
        _count: { _all: true },
        _sum: { rewardAmount: true, spendAmount: true },
      }),
      prismaUnscoped.rewardGrant.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prismaUnscoped.rewardGrant.findMany({ where, select: { vhicasarId: true }, distinct: ['vhicasarId'] }),
      prismaUnscoped.rewardGrant.groupBy({
        by: ['organizationId'],
        where,
        _count: { _all: true },
        _sum: { rewardAmount: true, spendAmount: true },
        orderBy: { _sum: { spendAmount: 'desc' } },
        take: 10,
      }),
    ]);

    const rewardGiven = agg._sum.rewardAmount ?? ZERO;
    const spendDriven = agg._sum.spendAmount ?? ZERO;
    // ROI: spend the campaign generated per unit of reward paid out.
    const roi = rewardGiven.greaterThan(ZERO) ? spendDriven.div(rewardGiven) : ZERO;

    const orgIds = byOrg.map((o) => o.organizationId).filter((x): x is string => Boolean(x));
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : [];

    return {
      grants: agg._count._all,
      rewardGiven: decimal(rewardGiven),
      spendDriven: decimal(spendDriven),
      roi: roi.toFixed(2),
      uniqueCustomers: uniqueCustomers.length,
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      topBusinesses: byOrg.map((o) => ({
        organizationId: o.organizationId,
        name: orgs.find((x) => x.id === o.organizationId)?.name ?? '—',
        grants: o._count._all,
        rewardGiven: decimal(o._sum.rewardAmount),
        spendDriven: decimal(o._sum.spendAmount),
      })),
    };
  },

  async pendingReviews(limit = 30) {
    const rows = await prismaUnscoped.rewardGrant.findMany({
      where: { status: 'PENDING_REVIEW' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { campaign: { select: { name: true } } },
    });
    return rows.map((g) => ({
      id: g.id,
      campaign: g.campaign.name,
      vhicasarId: g.vhicasarId,
      organizationId: g.organizationId,
      spendAmount: decimal(g.spendAmount),
      rewardAmount: decimal(g.rewardAmount),
      currency: g.currency,
      riskScore: g.riskScore,
      reasons: g.reviewNotes,
      createdAt: g.createdAt,
    }));
  },

  /** Expire reward funds whose window has passed. */
  async expireStaleGrants(): Promise<number> {
    const due = await prismaUnscoped.rewardGrant.findMany({
      where: { status: 'GRANTED', expiresAt: { lte: new Date() } },
      include: { campaign: { select: { targetBucket: true } } },
      take: 100,
    });
    let expired = 0;
    for (const grant of due) {
      const claimed = await prismaUnscoped.rewardGrant.updateMany({
        where: { id: grant.id, status: 'GRANTED' },
        data: { status: 'EXPIRED' },
      });
      if (claimed.count !== 1) continue;
      try {
        const wallet = await prismaUnscoped.wallet.findFirst({
          where: { vhicasarId: grant.vhicasarId, currency: grant.currency, purpose: 'USER' },
        });
        if (!wallet) continue;
        const column = grant.campaign.targetBucket === 'CASHBACK' ? 'cashbackBalance' : 'rewardBalance';
        const held = wallet[column];
        // Only reclaim what's still there — the customer may have spent it.
        const reclaim = held.greaterThanOrEqualTo(grant.rewardAmount) ? grant.rewardAmount : held;
        if (!reclaim.greaterThan(ZERO)) continue;

        const pool = await (await import('./../payments/wallet-ledger.service')).walletLedger.getOrCreatePlatformWallet(
          'REWARDS_POOL',
          grant.currency
        );
        await (await import('./../payments/wallet-ledger.service')).walletLedger.post({
          type: 'ADJUSTMENT',
          currency: grant.currency,
          amount: reclaim,
          initiatorVhicasarId: grant.vhicasarId,
          description: 'Reward expired',
          idempotencyKey: `reward-expire:${grant.id}`,
          legs: [
            { walletId: wallet.id, direction: 'DEBIT', amount: reclaim, bucket: grant.campaign.targetBucket },
            { walletId: pool.id, direction: 'CREDIT', amount: reclaim },
          ],
        });
        expired += 1;
      } catch (err) {
        logger.error({ err, grantId: grant.id }, 'reward expiry failed');
      }
    }
    return expired;
  },
};
