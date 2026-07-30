import { Router, type Request, type Response } from 'express';
import { logger } from '../../shared/logger';
import { paystack, flutterwave, stripe } from '../../infrastructure/payments';
import type { PaymentProvider } from '../../infrastructure/payments';
import { billingService } from '../../application/billing/billing.service';

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
    void billingService.handleWebhookEvent(event).catch((err) => {
      logger.error({ err, provider: provider.name }, 'Payment webhook processing failed');
    });
  };
}

paystackWebhookRoutes.post('/', makeHandler(paystack, 'x-paystack-signature'));
flutterwaveWebhookRoutes.post('/', makeHandler(flutterwave, 'verif-hash'));
stripeWebhookRoutes.post('/', makeHandler(stripe, 'stripe-signature'));
