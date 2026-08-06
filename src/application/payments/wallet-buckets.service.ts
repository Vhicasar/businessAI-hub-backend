import { Prisma } from '@prisma/client';
import type { WalletBucket } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { money, ZERO } from '../../shared/money';
import { emitEvent } from '../../shared/domain-events';
import { auditService } from '../audit/audit.service';
import { vhicasarIdService } from '../identity/vhicasar-id.service';
import { walletLedger } from './wallet-ledger.service';

/**
 * Wallet buckets and locked funds (§12, §22).
 *
 * A customer's wallet holds four separate balances. They are all the
 * customer's money, but they differ in what may be done with them:
 *
 *   AVAILABLE — spend, transfer, withdraw
 *   LOCKED    — spend inside the ecosystem only; never withdrawn or transferred
 *   REWARD    — earned from campaigns; spendable, may expire, not withdrawable
 *   CASHBACK  — earned from promotions; behaves like reward funds
 *
 * Locking is always the customer's own choice and is one-way by design: the
 * point of the feature is that the money stays in the ecosystem, so an
 * "unlock" path would defeat it. Platform admins can still release funds.
 */

/** Buckets that may be used to pay a business, in default priority order. */
export const SPENDABLE_BUCKETS: WalletBucket[] = ['REWARD', 'CASHBACK', 'LOCKED', 'AVAILABLE'];

/** Buckets that can leave the platform. */
const WITHDRAWABLE: WalletBucket[] = ['AVAILABLE'];

export interface LockConfig {
  enabled: boolean;
  minLockAmount: string;
  maxLockAmount: string | null;
  eligibleCountries: string[];
}

/** Platform defaults; overridden by admin config when present. */
const DEFAULT_LOCK_CONFIG: LockConfig = {
  enabled: true,
  minLockAmount: '1000',
  maxLockAmount: null,
  eligibleCountries: [],
};

export const walletBuckets = {
  SPENDABLE_BUCKETS,
  WITHDRAWABLE,

  /** The four balances plus their total, for the wallet screen (§22). */
  async breakdown(vhicasarId: string, currency: string) {
    const wallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());
    const total = wallet.balance
      .plus(wallet.lockedBalance)
      .plus(wallet.rewardBalance)
      .plus(wallet.cashbackBalance);
    return {
      currency: wallet.currency,
      available: wallet.balance.toFixed(2),
      locked: wallet.lockedBalance.toFixed(2),
      reward: wallet.rewardBalance.toFixed(2),
      cashback: wallet.cashbackBalance.toFixed(2),
      total: total.toFixed(2),
      /** What can actually leave the platform. */
      withdrawable: wallet.balance.toFixed(2),
    };
  },

  async lockConfig(): Promise<LockConfig> {
    // Platform-level switch lives in the admin-synced workspace config; fall
    // back to defaults so the feature works before an admin configures it.
    try {
      const { getWorkspaceConfig } = await import('../settings/workspace-config');
      const cfg = getWorkspaceConfig() as unknown as Record<string, unknown> | undefined;
      const locked = (cfg?.lockedWallet ?? {}) as Partial<LockConfig>;
      return { ...DEFAULT_LOCK_CONFIG, ...locked };
    } catch {
      return DEFAULT_LOCK_CONFIG;
    }
  },

  /**
   * Move funds from the available balance into the locked balance.
   *
   * This is the "lock this amount for Vhicasar payments only" choice — either
   * taken at top-up time or applied later to money already in the wallet.
   */
  async lockFunds(vhicasarId: string, amountRaw: number | string, currency: string, reason = 'CUSTOMER_CHOICE') {
    const config = await this.lockConfig();
    if (!config.enabled) {
      throw new AppError('LOCKED_WALLET_DISABLED', 409, 'Locked wallets are not available right now.');
    }

    const amount = money(amountRaw);
    if (!amount.greaterThan(ZERO)) throw new ValidationError('Enter an amount greater than zero');
    if (amount.lessThan(config.minLockAmount)) {
      throw new AppError('BELOW_MIN_LOCK', 400, `The minimum you can lock is ${config.minLockAmount}.`);
    }
    if (config.maxLockAmount && amount.greaterThan(config.maxLockAmount)) {
      throw new AppError('ABOVE_MAX_LOCK', 400, `The most you can lock is ${config.maxLockAmount}.`);
    }

    const wallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());

    // Both legs are on the same wallet — this is a bucket transfer, not a
    // movement of money between owners, so the totals are unchanged.
    const txn = await walletLedger.post({
      type: 'ADJUSTMENT',
      currency: currency.toUpperCase(),
      amount,
      initiatorVhicasarId: vhicasarId,
      description: 'Funds locked for in-platform spending',
      metadata: { reason } as Prisma.InputJsonValue,
      legs: [
        { walletId: wallet.id, direction: 'DEBIT', amount, bucket: 'AVAILABLE' },
        { walletId: wallet.id, direction: 'CREDIT', amount, bucket: 'LOCKED' },
      ],
    });

    await auditService.record({
      action: 'wallet.funds_locked',
      entityType: 'Wallet',
      entityId: wallet.id,
      after: { amount: amount.toFixed(2), currency, reason },
      actorType: 'USER',
    });
    await emitEvent({
      name: 'WalletFundsLocked',
      aggregateType: 'Wallet',
      aggregateId: wallet.id,
      payload: { vhicasarId, amount: amount.toFixed(2), currency, reason },
      organizationId: null,
    });

    return { transactionId: txn.id, ...(await this.breakdown(vhicasarId, currency)) };
  },

  /**
   * Platform-only release of locked funds back to available.
   *
   * Deliberately not customer-callable: locking is a commitment, and a
   * self-service unlock would make the guarantee meaningless. Support can still
   * release funds for genuine cases (account closure, dispute, error).
   */
  async releaseLockedFunds(vhicasarId: string, amountRaw: number | string, currency: string, reason: string) {
    const amount = money(amountRaw);
    if (!amount.greaterThan(ZERO)) throw new ValidationError('Enter an amount greater than zero');
    const wallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());
    if (wallet.lockedBalance.lessThan(amount)) {
      throw new AppError('INSUFFICIENT_LOCKED_FUNDS', 409, 'Not enough locked funds to release.');
    }

    const txn = await walletLedger.post({
      type: 'ADJUSTMENT',
      currency: currency.toUpperCase(),
      amount,
      initiatorVhicasarId: vhicasarId,
      description: `Locked funds released: ${reason}`,
      legs: [
        { walletId: wallet.id, direction: 'DEBIT', amount, bucket: 'LOCKED' },
        { walletId: wallet.id, direction: 'CREDIT', amount, bucket: 'AVAILABLE' },
      ],
    });

    await auditService.record({
      action: 'wallet.locked_funds_released',
      entityType: 'Wallet',
      entityId: wallet.id,
      after: { amount: amount.toFixed(2), currency, reason },
      actorType: 'SYSTEM',
    });
    return { transactionId: txn.id, ...(await this.breakdown(vhicasarId, currency)) };
  },

  /**
   * Work out which buckets fund a payment, honouring the customer's chosen
   * priority. Returns the legs to post, or throws if the money isn't there.
   *
   * Locked funds are only usable at businesses that accept them, so an
   * organisation opting out can't be paid with restricted money.
   */
  async planPayment(params: {
    vhicasarId: string;
    currency: string;
    amount: Prisma.Decimal;
    organizationId?: string | null;
    /** Customer's preferred order; defaults to spending restricted money first. */
    priority?: WalletBucket[];
  }): Promise<Array<{ bucket: WalletBucket; amount: Prisma.Decimal }>> {
    const wallet = await walletLedger.getOrCreateUserWallet(params.vhicasarId, params.currency.toUpperCase());

    let acceptsLocked = true;
    if (params.organizationId) {
      const profile = await prismaUnscoped.businessProfile.findUnique({
        where: { organizationId: params.organizationId },
        select: { acceptsLockedFunds: true },
      });
      acceptsLocked = profile?.acceptsLockedFunds ?? true;
    }

    const balances: Record<WalletBucket, Prisma.Decimal> = {
      AVAILABLE: wallet.balance,
      LOCKED: acceptsLocked ? wallet.lockedBalance : ZERO,
      REWARD: wallet.rewardBalance,
      CASHBACK: wallet.cashbackBalance,
    };

    // Spend the most restricted money first by default — it can't be withdrawn,
    // so using it before free cash is what the customer would want.
    const order = params.priority?.length ? params.priority : SPENDABLE_BUCKETS;

    const plan: Array<{ bucket: WalletBucket; amount: Prisma.Decimal }> = [];
    let remaining = params.amount;

    for (const bucket of order) {
      if (!remaining.greaterThan(ZERO)) break;
      const available = balances[bucket] ?? ZERO;
      if (!available.greaterThan(ZERO)) continue;
      const take = available.greaterThanOrEqualTo(remaining) ? remaining : available;
      plan.push({ bucket, amount: money(take.toFixed(4)) });
      remaining = remaining.minus(take);
    }

    if (remaining.greaterThan(ZERO)) {
      throw new AppError(
        'INSUFFICIENT_FUNDS',
        402,
        acceptsLocked
          ? 'Your wallet balance is not enough for this payment.'
          : 'This business does not accept locked funds, and your available balance is not enough.'
      );
    }
    return plan;
  },

  /** Credit a specific bucket — used by reward campaigns and cashback. */
  async credit(params: {
    vhicasarId: string;
    currency: string;
    amount: Prisma.Decimal;
    bucket: WalletBucket;
    sourceWalletPurpose?: 'FEES' | 'REWARDS_POOL' | 'GATEWAY_CLEARING';
    description: string;
    idempotencyKey?: string;
    organizationId?: string | null;
  }) {
    const currency = params.currency.toUpperCase();
    const userWallet = await walletLedger.getOrCreateUserWallet(params.vhicasarId, currency);
    const source = await walletLedger.getOrCreatePlatformWallet(
      params.sourceWalletPurpose ?? 'REWARDS_POOL',
      currency
    );

    const txn = await walletLedger.post({
      type: 'ADJUSTMENT',
      currency,
      amount: params.amount,
      initiatorVhicasarId: params.vhicasarId,
      organizationId: params.organizationId ?? null,
      description: params.description,
      idempotencyKey: params.idempotencyKey,
      legs: [
        { walletId: source.id, direction: 'DEBIT', amount: params.amount },
        { walletId: userWallet.id, direction: 'CREDIT', amount: params.amount, bucket: params.bucket },
      ],
    });

    await emitEvent({
      name: 'WalletCredited',
      aggregateType: 'Wallet',
      aggregateId: userWallet.id,
      payload: {
        vhicasarId: params.vhicasarId,
        amount: params.amount.toFixed(2),
        currency,
        bucket: params.bucket,
        transactionId: txn.id,
      },
      organizationId: params.organizationId ?? null,
    });
    return txn;
  },

  /** Statement filtered to one bucket, so "where did my locked money go?" is answerable. */
  async statement(vhicasarId: string, currency: string, opts: { bucket?: WalletBucket; cursor?: string; limit: number }) {
    const wallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());
    const rows = await prismaUnscoped.walletEntry.findMany({
      where: { walletId: wallet.id, ...(opts.bucket ? { bucket: opts.bucket } : {}) },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { transaction: { select: { type: true, description: true, reference: true } } },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((e) => ({
        id: e.id,
        direction: e.direction,
        bucket: e.bucket,
        amount: e.amount.toFixed(2),
        balanceAfter: e.balanceAfter.toFixed(2),
        currency: e.currency,
        type: e.transaction.type,
        description: e.transaction.description,
        createdAt: e.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },
};
