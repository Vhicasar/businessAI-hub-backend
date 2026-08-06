import { Router, type Request, type Response } from 'express';
import { logger } from '../../shared/logger';
import { paystack, flutterwave, stripe } from '../../infrastructure/payments';
import type { PaymentProvider } from '../../infrastructure/payments';
import { billingService } from '../../application/billing/billing.service';
import { vhicasarPayService } from '../../application/payments/vhicasar-pay.service';
import { payoutService } from '../../application/payments/payout.service';
import { prismaUnscoped } from '../../infrastructure/database/prisma';

/**
 * Public payment webhook receivers:
 *   POST /api/webhooks/paystack     (x-paystack-signature, HMAC-SHA512)
 *   POST /api/webhooks/flutterwave  (verif-hash header == dashboard secret hash)
 *   POST /api/webhooks/stripe       (stripe-signature, HMAC-SHA256 of t.payload)
 *
 * Each verifies its provider's signature before processing, then normalizes the
 * event so the billing service handles first charges, recurring renewals and
 * cancellations the same way regardless of gateway. Always answers 200 quickly
 * so the provider does not retry; work is done best-effort and re-verified
 * against the provider API for integrity.
 */
export const paystackWebhookRoutes = Router();
export const flutterwaveWebhookRoutes = Router();
export const stripeWebhookRoutes = Router();

function makeHandler(provider: PaymentProvider, signatureHeader: string) {
  return (req: Request, res: Response) => {
    const signature = req.headers[signatureHeader] as string | undefined;
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));

    if (!provider.verifyWebhookSignature(raw, signature)) {
      logger.warn(`Rejected ${provider.name} webhook with invalid signature`);
      res.sendStatus(401);
      return;
    }

    // Acknowledge immediately; process asynchronously.
    res.sendStatus(200);

    const event = provider.parseWebhookEvent(req.body);

    // Vhicasar Pay wallet top-ups own the `vptop_` reference space — credit the
    // wallet here instead of running the event through subscription billing.
    if (event.type === 'charge_success' && event.reference?.startsWith('vptop_')) {
      void vhicasarPayService.confirmTopUp(event.reference).catch((err) => {
        logger.error({ err, provider: provider.name, reference: event.reference }, 'Wallet top-up webhook failed');
      });
      return;
    }

    // Bank payouts: `transfer.*` events settle a Payout to its final state so a
    // customer's money is never left waiting on the reconciliation sweep.
    void handleTransferEvent(req.body).catch((err) => {
      logger.error({ err, provider: provider.name }, 'Payout webhook processing failed');
    });

    void billingService.handleWebhookEvent(event).catch((err) => {
      logger.error({ err, provider: provider.name }, 'Payment webhook processing failed');
    });
  };
}

/**
 * Resolve a payout from a gateway transfer webhook. Reference-first (that's what
 * we generated), falling back to the gateway's own id. Both mark* calls are
 * idempotent, so a replayed webhook is harmless.
 */
async function handleTransferEvent(body: unknown): Promise<void> {
  const evt = body as { event?: string; data?: Record<string, unknown> } | null;
  const name = String(evt?.event ?? '').toLowerCase();
  if (!name.startsWith('transfer')) return;

  const data = evt?.data ?? {};
  const reference = typeof data.reference === 'string' ? data.reference : undefined;
  const transferCode = typeof data.transfer_code === 'string' ? data.transfer_code : undefined;
  if (!reference && !transferCode) return;

  const payout = await prismaUnscoped.payout.findFirst({
    where: {
      OR: [
        ...(reference ? [{ idempotencyKey: reference }] : []),
        ...(transferCode ? [{ providerRef: transferCode }] : []),
      ],
    },
    select: { id: true },
  });
  if (!payout) return;

  if (name.includes('success')) await payoutService.markPaid(payout.id);
  else if (name.includes('failed') || name.includes('reversed')) {
    await payoutService.markFailed(payout.id, `Gateway reported ${name}`);
  }
}

paystackWebhookRoutes.post('/', makeHandler(paystack, 'x-paystack-signature'));
flutterwaveWebhookRoutes.post('/', makeHandler(flutterwave, 'verif-hash'));
stripeWebhookRoutes.post('/', makeHandler(stripe, 'stripe-signature'));
