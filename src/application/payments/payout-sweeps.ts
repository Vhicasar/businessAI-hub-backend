import { logger } from '../../shared/logger';
import { deviceSignatureService } from '../identity/device-signature.service';
import { payoutService } from './payout.service';
import { rewardsService } from '../rewards/rewards.service';
import { rewardCampaigns } from '../rewards/reward-campaign.service';

/**
 * Background upkeep for money-out flows.
 *
 * Reconciliation matters because a payout that never resolves strands a
 * customer's money in the clearing wallet: a missed webhook must not be the
 * only path to a final state.
 */

let payoutTimer: NodeJS.Timeout | null = null;
let nonceTimer: NodeJS.Timeout | null = null;

export function startPayoutReconciliation(intervalMs = 120_000): void {
  if (payoutTimer) return;
  const tick = async () => {
    try {
      const n = await payoutService.reconcilePending();
      if (n > 0) logger.info({ resolved: n }, 'payouts reconciled');
    } catch (err) {
      logger.error({ err }, 'payout reconciliation tick failed');
    }
  };
  payoutTimer = setInterval(() => void tick(), intervalMs);
  if (typeof payoutTimer.unref === 'function') payoutTimer.unref();
  logger.info(`💸 Payout reconciliation started (${intervalMs}ms interval)`);
}

export function startNoncePurge(intervalMs = 900_000): void {
  if (nonceTimer) return;
  const tick = async () => {
    try {
      const n = await deviceSignatureService.purgeExpiredNonces();
      if (n > 0) logger.debug({ purged: n }, 'expired payment nonces purged');
    } catch (err) {
      logger.error({ err }, 'nonce purge failed');
    }
  };
  nonceTimer = setInterval(() => void tick(), intervalMs);
  if (typeof nonceTimer.unref === 'function') nonceTimer.unref();
}

let rewardsTimer: NodeJS.Timeout | null = null;

/** Daily sweep expiring reward points past their two-year window. */
export function startRewardExpiry(intervalMs = 24 * 60 * 60 * 1000): void {
  if (rewardsTimer) return;
  const tick = async () => {
    try {
      const n = await rewardsService.expireStale();
      if (n > 0) logger.info({ expired: n }, 'reward entries expired');
      const g = await rewardCampaigns.expireStaleGrants();
      if (g > 0) logger.info({ expired: g }, 'campaign reward grants expired');
    } catch (err) {
      logger.error({ err }, 'reward expiry sweep failed');
    }
  };
  rewardsTimer = setInterval(() => void tick(), intervalMs);
  if (typeof rewardsTimer.unref === 'function') rewardsTimer.unref();
}

let settlementTimer: NodeJS.Timeout | null = null;

/**
 * Release settlements that have come due (§10).
 *
 * The schedule a business chooses — instant, hourly, daily, weekly — is stored
 * as `scheduledFor` on each settlement, so this only has to ask "what is due
 * now?" rather than reimplement the calendar.
 */
export function startSettlementRuns(intervalMs = 300_000): void {
  if (settlementTimer) return;
  const tick = async () => {
    try {
      const { settlementEngine } = await import('./settlement-engine.service');
      const result = await settlementEngine.runDue();
      if (result.processed > 0) logger.info({ processed: result.processed }, 'settlements executed');

      const released = await releaseMaturedReserves();
      if (released > 0) logger.info({ released }, 'settlement reserves released');
    } catch (err) {
      logger.error({ err }, 'settlement run failed');
    }
  };
  settlementTimer = setInterval(() => void tick(), intervalMs);
  if (typeof settlementTimer.unref === 'function') settlementTimer.unref();
  logger.info(`🏦 Settlement runs started (${intervalMs}ms interval)`);
}

/**
 * Return held-back reserve to the merchant once its window has passed (§10).
 *
 * Without this the reserve would simply be lost to the business, which is the
 * one outcome a reserve must never produce.
 */
async function releaseMaturedReserves(): Promise<number> {
  const { prismaUnscoped } = await import('../../infrastructure/database/prisma');
  const { walletLedger } = await import('./wallet-ledger.service');

  const due = await prismaUnscoped.settlement.findMany({
    where: {
      status: 'PAID',
      reserveReleaseAt: { lte: new Date() },
      reserveAmount: { gt: 0 },
    },
    take: 50,
  });

  let released = 0;
  for (const s of due) {
    try {
      const merchant = await walletLedger.getOrCreateOrgWallet(s.organizationId, 'MERCHANT', s.currency);
      const payable = await walletLedger.getOrCreateOrgWallet(s.organizationId, 'SETTLEMENT_PAYABLE', s.currency);
      await walletLedger.post({
        type: 'SETTLEMENT',
        currency: s.currency,
        amount: s.reserveAmount,
        organizationId: s.organizationId,
        description: 'Settlement reserve released',
        // Keyed so a repeated sweep cannot release the same reserve twice.
        idempotencyKey: `reserve-release:${s.id}`,
        legs: [
          { walletId: payable.id, direction: 'DEBIT', amount: s.reserveAmount },
          { walletId: merchant.id, direction: 'CREDIT', amount: s.reserveAmount },
        ],
      });
      await prismaUnscoped.settlement.update({
        where: { id: s.id },
        data: { reserveReleaseAt: null },
      });
      released += 1;
    } catch (err) {
      logger.error({ err, settlementId: s.id }, 'reserve release failed');
    }
  }
  return released;
}

export function stopPayoutSweeps(): void {
  if (rewardsTimer) clearInterval(rewardsTimer);
  rewardsTimer = null;
  if (payoutTimer) clearInterval(payoutTimer);
  if (nonceTimer) clearInterval(nonceTimer);
  if (settlementTimer) clearInterval(settlementTimer);
  payoutTimer = null;
  nonceTimer = null;
  settlementTimer = null;
}
