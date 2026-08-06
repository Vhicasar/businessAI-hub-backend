import { Prisma } from '@prisma/client';
import type { RewardTier } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors';
import { emitEvent } from '../../shared/domain-events';
import { money } from '../../shared/money';

/**
 * Universal rewards — points earned at ANY participating business through
 * Vhicasar Pay and spendable at ANY other. This is the cross-business
 * differentiator; the per-org `LoyaltyAccount` remains each business's own
 * private programme and is untouched here.
 *
 * Not tenant-scoped (the balance belongs to the person, not a business), so
 * everything uses the unscoped client — same reasoning as the wallet ledger.
 */

/** Points per 1 major currency unit spent. */
const EARN_RATE = 1;

/** Currency value of one point when redeeming. */
const REDEEM_RATE = new Prisma.Decimal('0.01');

/** Points expire after two years of inactivity on the earning entry. */
const EXPIRY_MONTHS = 24;

const TIER_THRESHOLDS: Array<{ tier: RewardTier; lifetime: number }> = [
  { tier: 'PLATINUM', lifetime: 500_000 },
  { tier: 'GOLD', lifetime: 100_000 },
  { tier: 'SILVER', lifetime: 20_000 },
  { tier: 'BRONZE', lifetime: 0 },
];

function tierFor(lifetime: number): RewardTier {
  return TIER_THRESHOLDS.find((t) => lifetime >= t.lifetime)?.tier ?? 'BRONZE';
}

/** Higher tiers earn faster — the reason to consolidate spend on Vhicasar Pay. */
function tierMultiplier(tier: RewardTier): number {
  switch (tier) {
    case 'PLATINUM':
      return 2;
    case 'GOLD':
      return 1.5;
    case 'SILVER':
      return 1.25;
    default:
      return 1;
  }
}

async function getOrCreateAccount(vhicasarId: string) {
  const existing = await prismaUnscoped.rewardAccount.findUnique({ where: { vhicasarId } });
  if (existing) return existing;
  return prismaUnscoped.rewardAccount.create({ data: { vhicasarId } });
}

/**
 * Append a ledger entry and move the balance atomically.
 * Redemptions use a guarded update so two concurrent spends can't overdraw.
 */
async function post(params: {
  vhicasarId: string;
  type: 'EARN' | 'REDEEM' | 'EXPIRE' | 'ADJUSTMENT' | 'REVERSAL';
  points: number; // signed
  organizationId?: string | null;
  paymentId?: string | null;
  description?: string;
  expiresAt?: Date | null;
}) {
  const account = await getOrCreateAccount(params.vhicasarId);

  if (params.points < 0) {
    const needed = Math.abs(params.points);
    const claimed = await prismaUnscoped.rewardAccount.updateMany({
      where: { id: account.id, balance: { gte: needed } },
      data: { balance: { decrement: needed } },
    });
    if (claimed.count !== 1) {
      throw new AppError('INSUFFICIENT_POINTS', 409, 'You do not have enough points for that.');
    }
  } else {
    await prismaUnscoped.rewardAccount.update({
      where: { id: account.id },
      data: {
        balance: { increment: params.points },
        ...(params.type === 'EARN' ? { lifetime: { increment: params.points } } : {}),
      },
    });
  }

  const fresh = await prismaUnscoped.rewardAccount.findUnique({ where: { id: account.id } });
  const balanceAfter = fresh?.balance ?? 0;

  const entry = await prismaUnscoped.rewardLedger.create({
    data: {
      accountId: account.id,
      vhicasarId: params.vhicasarId,
      type: params.type,
      points: params.points,
      balanceAfter,
      organizationId: params.organizationId ?? null,
      paymentId: params.paymentId ?? null,
      description: params.description ?? null,
      expiresAt: params.expiresAt ?? null,
    },
  });

  // Tier follows lifetime earnings, so it never drops when points are spent.
  if (fresh) {
    const nextTier = tierFor(fresh.lifetime);
    if (nextTier !== fresh.tier) {
      await prismaUnscoped.rewardAccount.update({ where: { id: account.id }, data: { tier: nextTier } });
      await emitEvent({
        name: 'RewardTierChanged',
        aggregateType: 'RewardAccount',
        aggregateId: account.id,
        payload: { vhicasarId: params.vhicasarId, tier: nextTier, previous: fresh.tier },
        organizationId: null,
      });
    }
  }

  return { entry, balanceAfter };
}

export const rewardsService = {
  EARN_RATE,
  REDEEM_RATE,
  tierMultiplier,

  async summary(vhicasarId: string) {
    const account = await getOrCreateAccount(vhicasarId);
    const value = REDEEM_RATE.mul(account.balance);
    const next = TIER_THRESHOLDS.filter((t) => t.lifetime > account.lifetime).pop();
    return {
      balance: account.balance,
      lifetime: account.lifetime,
      tier: account.tier,
      multiplier: tierMultiplier(account.tier),
      /** What the balance is worth if redeemed today. */
      redeemableValue: value.toFixed(2),
      redeemRate: REDEEM_RATE.toFixed(4),
      nextTier: next ? { tier: next.tier, pointsNeeded: next.lifetime - account.lifetime } : null,
    };
  },

  async history(vhicasarId: string, opts: { cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.rewardLedger.findMany({
      where: { vhicasarId },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;

    // Name the businesses in one query rather than per row.
    const orgIds = [...new Set(items.map((r) => r.organizationId).filter((x): x is string => Boolean(x)))];
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : [];

    return {
      items: items.map((r) => ({
        id: r.id,
        type: r.type,
        points: r.points,
        balanceAfter: r.balanceAfter,
        business: orgs.find((o) => o.id === r.organizationId)?.name ?? null,
        description: r.description,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * Award points for a completed Vhicasar Pay payment. Idempotent per payment:
   * a replayed event must never mint points twice.
   */
  async earnForPayment(params: {
    vhicasarId: string;
    organizationId: string | null;
    paymentId: string;
    amount: Prisma.Decimal | string | number;
    currency: string;
  }) {
    const already = await prismaUnscoped.rewardLedger.findFirst({
      where: { paymentId: params.paymentId, type: 'EARN' },
      select: { id: true },
    });
    if (already) return null;

    const account = await getOrCreateAccount(params.vhicasarId);
    const amount = money(params.amount);
    const base = Math.floor(Number(amount.toFixed(2)) * EARN_RATE);
    const points = Math.floor(base * tierMultiplier(account.tier));
    if (points <= 0) return null;

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + EXPIRY_MONTHS);

    const { balanceAfter } = await post({
      vhicasarId: params.vhicasarId,
      type: 'EARN',
      points,
      organizationId: params.organizationId,
      paymentId: params.paymentId,
      description: 'Points earned on payment',
      expiresAt,
    });

    await emitEvent({
      name: 'RewardEarned',
      aggregateType: 'RewardAccount',
      aggregateId: account.id,
      payload: { vhicasarId: params.vhicasarId, points, balanceAfter, paymentId: params.paymentId },
      organizationId: params.organizationId,
    });
    return { points, balanceAfter };
  },

  /**
   * Redeem points for wallet credit, spendable at any business.
   * Points are burned first (so concurrent redemptions can't double-spend the
   * balance), then credited to the wallet. A failed credit is compensated with
   * a REVERSAL entry — the customer never loses points without getting value.
   */
  async redeem(vhicasarId: string, points: number, currency: string) {
    if (!Number.isInteger(points) || points <= 0) {
      throw new ValidationError('Enter a whole number of points to redeem');
    }
    const value = REDEEM_RATE.mul(points);
    if (!value.greaterThan(0)) throw new ValidationError('That is too few points to redeem');

    // Burn the points first so two concurrent redemptions can't spend the same
    // balance. The reward ledger and the money ledger are separate systems, so
    // if the wallet credit then fails we MUST hand the points back — otherwise
    // the customer loses points and gets nothing.
    const { balanceAfter } = await post({
      vhicasarId,
      type: 'REDEEM',
      points: -points,
      description: `Redeemed for ${value.toFixed(2)} ${currency.toUpperCase()}`,
    });

    let txn;
    try {
      // Dynamic import keeps rewards ↔ payments from becoming a static cycle.
      const { walletLedger } = await import('../payments/wallet-ledger.service');
      const userWallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());
      // Redemptions are funded by the platform's reward liability account, which
      // is expected to run negative as promised value is handed out.
      const rewardsPool = await walletLedger.getOrCreatePlatformWallet('REWARDS_POOL', currency.toUpperCase());

      txn = await walletLedger.post({
        type: 'ADJUSTMENT',
        currency: currency.toUpperCase(),
        amount: value,
        initiatorVhicasarId: vhicasarId,
        description: 'Reward redemption',
        idempotencyKey: `reward-redeem:${vhicasarId}:${Date.now()}`,
        legs: [
          { walletId: rewardsPool.id, direction: 'DEBIT', amount: value },
          { walletId: userWallet.id, direction: 'CREDIT', amount: value },
        ],
      });

      const wallet = await walletLedger.balance(userWallet.id);
      await emitEvent({
        name: 'RewardRedeemed',
        aggregateType: 'RewardAccount',
        aggregateId: vhicasarId,
        payload: { vhicasarId, points, value: value.toFixed(2), currency, transactionId: txn.id },
        organizationId: null,
      });

      return {
        pointsRedeemed: points,
        value: value.toFixed(2),
        currency: currency.toUpperCase(),
        pointsBalance: balanceAfter,
        wallet: { balance: wallet.balance.toFixed(2), currency: wallet.currency },
      };
    } catch (err) {
      // Compensating entry, not a silent rollback: the failed redemption and its
      // reversal both stay on the ledger so the balance is always explainable.
      await post({
        vhicasarId,
        type: 'REVERSAL',
        points,
        description: 'Redemption reversed — wallet credit failed',
      });
      throw err;
    }
  },

  /** Platform grant/correction (support tooling). */
  async adjust(vhicasarId: string, points: number, description: string) {
    const { balanceAfter } = await post({
      vhicasarId,
      type: 'ADJUSTMENT',
      points,
      description,
    });
    return { balanceAfter };
  },

  /**
   * Expire points from EARN entries older than the expiry window.
   * Runs as a daily sweep; only ever removes what is still available.
   */
  async expireStale(): Promise<number> {
    const due = await prismaUnscoped.rewardLedger.findMany({
      where: { type: 'EARN', expiresAt: { lte: new Date() } },
      take: 200,
    });
    let expired = 0;
    for (const entry of due) {
      // Mark it consumed first so a re-run can't expire the same points twice.
      const claimed = await prismaUnscoped.rewardLedger.updateMany({
        where: { id: entry.id, expiresAt: { not: null } },
        data: { expiresAt: null },
      });
      if (claimed.count !== 1) continue;

      const account = await prismaUnscoped.rewardAccount.findUnique({ where: { vhicasarId: entry.vhicasarId } });
      const removable = Math.min(entry.points, account?.balance ?? 0);
      if (removable <= 0) continue;

      await post({
        vhicasarId: entry.vhicasarId,
        type: 'EXPIRE',
        points: -removable,
        description: 'Points expired',
      });
      expired += 1;
    }
    return expired;
  },
};
