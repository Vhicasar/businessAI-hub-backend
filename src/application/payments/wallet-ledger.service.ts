import { Prisma } from '@prisma/client';
import type { WalletBucket } from '@prisma/client';
import type { Wallet, WalletPurpose, WalletTransaction, WalletTxType } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors';
import { money, ZERO } from '../../shared/money';

/**
 * Double-entry wallet ledger — the money-integrity core of Vhicasar Pay.
 *
 * Every movement is a balanced posting: the sum of DEBIT legs equals the sum of
 * CREDIT legs. WalletEntry rows are immutable and are the source of truth;
 * Wallet.balance is a cached running total kept in lock-step. Debits use a
 * guarded atomic decrement (`balance >= amount`) so concurrent spends can never
 * overdraw a consumer/merchant wallet. PLATFORM clearing/suspense accounts may
 * go negative (they mirror money held outside the ledger).
 *
 * Uses the UNSCOPED client on purpose: a single posting spans consumer, merchant
 * and platform wallets across org boundaries, so tenant auto-scoping must not
 * apply. Callers are trusted service code, never raw request input.
 */

export class InsufficientFundsError extends AppError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 402, 'Insufficient wallet balance');
  }
}

/**
 * Platform suspense/liability accounts. These legitimately run negative as the
 * platform takes on an obligation (funds in flight, payouts owed, reward value
 * promised) — unlike a consumer or merchant wallet, which must never overdraw.
 */
/** Wallet column backing each bucket. */
const BUCKET_COLUMN = {
  AVAILABLE: 'balance',
  LOCKED: 'lockedBalance',
  REWARD: 'rewardBalance',
  CASHBACK: 'cashbackBalance',
} as const satisfies Record<WalletBucket, 'balance' | 'lockedBalance' | 'rewardBalance' | 'cashbackBalance'>;

const NEGATIVE_ALLOWED: ReadonlySet<WalletPurpose> = new Set<WalletPurpose>([
  'GATEWAY_CLEARING',
  'SETTLEMENT_PAYABLE',
  'REWARDS_POOL',
]);

export interface PostingLeg {
  walletId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: Prisma.Decimal;
  /**
   * Which sub-balance to move. Defaults to the ordinary spendable balance;
   * LOCKED / REWARD / CASHBACK move their own columns so restricted money can
   * never be silently spent as if it were free cash (§12, §22).
   */
  bucket?: WalletBucket;
}

export interface PostingInput {
  type: WalletTxType;
  currency: string;
  legs: PostingLeg[];
  amount?: Prisma.Decimal; // principal; defaults to the debit total
  organizationId?: string | null;
  initiatorVhicasarId?: string | null;
  reference?: string;
  description?: string;
  idempotencyKey?: string;
  paymentSessionId?: string;
  metadata?: Prisma.InputJsonValue;
}

export const walletLedger = {
  async getOrCreateUserWallet(vhicasarId: string, currency: string): Promise<Wallet> {
    const existing = await prismaUnscoped.wallet.findUnique({
      where: { vhicasarId_currency: { vhicasarId, currency } },
    });
    if (existing) return existing;
    return prismaUnscoped.wallet.create({
      data: { ownerType: 'VHICASAR_ID', vhicasarId, purpose: 'USER', currency },
    });
  },

  async getOrCreateOrgWallet(
    organizationId: string,
    purpose: Extract<WalletPurpose, 'MERCHANT' | 'FEES' | 'SETTLEMENT_PAYABLE'>,
    currency: string
  ): Promise<Wallet> {
    const existing = await prismaUnscoped.wallet.findUnique({
      where: { organizationId_purpose_currency: { organizationId, purpose, currency } },
    });
    if (existing) return existing;
    return prismaUnscoped.wallet.create({
      data: { ownerType: 'ORGANIZATION', organizationId, purpose, currency },
    });
  },

  async getOrCreatePlatformWallet(
    purpose: Extract<WalletPurpose, 'GATEWAY_CLEARING' | 'SETTLEMENT_PAYABLE' | 'FEES' | 'REWARDS_POOL'>,
    currency: string
  ): Promise<Wallet> {
    const platformKey = `${purpose}:${currency}`;
    const existing = await prismaUnscoped.wallet.findUnique({ where: { platformKey } });
    if (existing) return existing;
    return prismaUnscoped.wallet.create({
      data: { ownerType: 'PLATFORM', platformKey, purpose, currency },
    });
  },

  /** Post a balanced double-entry transaction. Atomic + overdraft-safe. */
  async post(input: PostingInput): Promise<WalletTransaction> {
    if (input.legs.length < 2) throw new AppError('INVALID_POSTING', 400, 'A posting needs at least two legs');

    let debitTotal = ZERO;
    let creditTotal = ZERO;
    for (const leg of input.legs) {
      if (leg.amount.lessThanOrEqualTo(ZERO)) {
        throw new AppError('INVALID_POSTING', 400, 'Posting amounts must be positive');
      }
      if (leg.direction === 'DEBIT') debitTotal = debitTotal.add(leg.amount);
      else creditTotal = creditTotal.add(leg.amount);
    }
    if (!debitTotal.equals(creditTotal)) {
      throw new AppError('UNBALANCED_POSTING', 500, 'Ledger posting is not balanced');
    }

    if (input.idempotencyKey) {
      const dup = await prismaUnscoped.walletTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (dup) return dup;
    }

    try {
      return await prismaUnscoped.$transaction(async (tx) => {
        const txn = await tx.walletTransaction.create({
          data: {
            type: input.type,
            status: 'POSTED',
            currency: input.currency,
            amount: input.amount ?? debitTotal,
            organizationId: input.organizationId ?? null,
            initiatorVhicasarId: input.initiatorVhicasarId ?? null,
            reference: input.reference ?? null,
            description: input.description ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            paymentSessionId: input.paymentSessionId ?? null,
            metadata: input.metadata,
            postedAt: new Date(),
          },
        });

        for (const leg of input.legs) {
          const wallet = await tx.wallet.findUnique({ where: { id: leg.walletId } });
          if (!wallet) throw new NotFoundError('Wallet');
          if (wallet.currency !== input.currency) {
            throw new AppError('CURRENCY_MISMATCH', 400, 'Wallet currency mismatch');
          }
          if (wallet.status !== 'ACTIVE') {
            throw new AppError('WALLET_INACTIVE', 409, 'Wallet is not active');
          }

          const bucket: WalletBucket = leg.bucket ?? 'AVAILABLE';
          const column = BUCKET_COLUMN[bucket];

          let balanceAfter: Prisma.Decimal;
          if (leg.direction === 'CREDIT') {
            const updated = await tx.wallet.update({
              where: { id: wallet.id },
              data: { [column]: { increment: leg.amount } },
            });
            balanceAfter = updated[column];
          } else if (NEGATIVE_ALLOWED.has(wallet.purpose)) {
            const updated = await tx.wallet.update({
              where: { id: wallet.id },
              data: { [column]: { decrement: leg.amount } },
            });
            balanceAfter = updated[column];
          } else {
            // Guarded decrement: only succeeds if that specific bucket actually
            // holds the funds, so locked money can't be drained as available.
            const res = await tx.wallet.updateMany({
              where: { id: wallet.id, [column]: { gte: leg.amount } },
              data: { [column]: { decrement: leg.amount } },
            });
            if (res.count !== 1) throw new InsufficientFundsError();
            const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
            balanceAfter = fresh[column];
          }

          await tx.walletEntry.create({
            data: {
              transactionId: txn.id,
              walletId: wallet.id,
              direction: leg.direction,
              bucket,
              amount: leg.amount,
              balanceAfter,
              currency: input.currency,
            },
          });
        }

        return txn;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // idempotency race — return the winner
        const dup = await prismaUnscoped.walletTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (dup) return dup;
        throw new ConflictError('Duplicate transaction');
      }
      throw e;
    }
  },

  async balance(walletId: string): Promise<Wallet> {
    const wallet = await prismaUnscoped.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundError('Wallet');
    return wallet;
  },

  async statement(walletId: string, opts: { cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.walletEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        transaction: { select: { type: true, description: true, reference: true, createdAt: true } },
      },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((e) => ({
        id: e.id,
        direction: e.direction,
        amount: e.amount.toFixed(2),
        balanceAfter: e.balanceAfter.toFixed(2),
        currency: e.currency,
        type: e.transaction.type,
        description: e.transaction.description,
        reference: e.transaction.reference,
        createdAt: e.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },
};
