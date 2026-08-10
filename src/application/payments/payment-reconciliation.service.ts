import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { paymentIntentService } from './payment-intent.service';
import { paymentWebhookService, methodFromProviderChannel } from './payment-webhook.service';
import { settlePaymentIntent } from './payment-settlement.service';
import { verifyWithProvider } from './payment-verification.service';

/**
 * The safety net under the webhooks.
 *
 * Webhooks get lost — providers drop them, endpoints are briefly down, a deploy
 * lands mid-delivery. Without this, a customer who has genuinely paid sits in
 * front of an order that still says unpaid, and the only fix is someone
 * noticing. This sweep asks the gateway directly about anything that looks
 * stuck and settles it through exactly the same path a webhook would.
 *
 * Everything is idempotent, so a sweep racing a late webhook is harmless: the
 * provider reference is unique, so whichever arrives second books nothing.
 */

export interface ReconcileReport {
  checked: number;
  settled: number;
  expired: number;
  webhooksRetried: number;
  webhooksRecovered: number;
}

/**
 * Sweep intents that have been awaiting payment long enough that a webhook
 * should have arrived.
 *
 * The lower bound matters: checking an intent seconds after it was raised just
 * hammers the gateway with questions about customers who are still typing
 * their card number.
 */
export async function reconcilePayments(
  opts: { olderThanMinutes?: number; limit?: number } = {}
): Promise<ReconcileReport> {
  const olderThan = new Date(Date.now() - (opts.olderThanMinutes ?? 5) * 60_000);
  const limit = opts.limit ?? 100;

  const report: ReconcileReport = {
    checked: 0,
    settled: 0,
    expired: 0,
    webhooksRetried: 0,
    webhooksRecovered: 0,
  };

  // 1. Events that arrived but could not be processed — a gateway that was
  //    briefly unreachable, say. Cheaper and more reliable than re-asking the
  //    provider, because the payload is already in hand.
  const retry = await paymentWebhookService.retryFailed();
  report.webhooksRetried = retry.retried;
  report.webhooksRecovered = retry.recovered;

  // 2. Intents the provider may have taken money for without telling us.
  const candidates = await prismaUnscoped.paymentIntent.findMany({
    where: {
      status: { in: ['AWAITING_PAYMENT', 'PROCESSING', 'PARTIALLY_PAID'] },
      createdAt: { lt: olderThan },
      // Only ones where a gateway was actually engaged. An intent nobody has
      // opened has no provider reference to ask about.
      provider: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  for (const intent of candidates) {
    report.checked += 1;
    try {
      const verified = await verifyWithProvider({
        organizationId: intent.organizationId,
        provider: intent.provider!,
        reference: intent.reference,
      });
      if (!verified.ok) continue;

      const result = await paymentIntentService.applyTransaction({
        organizationId: intent.organizationId,
        paymentIntentId: intent.id,
        provider: intent.provider!,
        providerRef: verified.providerRef,
        method: intent.method ?? methodFromProviderChannel(null),
        amount: verified.amount,
        currency: verified.currency,
        status: 'SUCCESS',
        paidAt: verified.paidAt,
      });

      if (result.applied) {
        await settlePaymentIntent(intent.id, { becamePaid: result.becamePaid });
        report.settled += 1;
        logger.info(
          { intentId: intent.id, reference: intent.reference },
          'reconciliation settled a payment the webhook never delivered'
        );
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, intentId: intent.id },
        'reconciliation check failed'
      );
    }
  }

  // 3. Close out anything genuinely abandoned, so the business's list of
  //    outstanding payments reflects reality.
  report.expired = await paymentIntentService.expireOverdue();

  return report;
}
