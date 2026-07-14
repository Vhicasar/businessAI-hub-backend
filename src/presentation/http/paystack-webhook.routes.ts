import { Router } from 'express';
import { logger } from '../../shared/logger';
import { paystack } from '../../infrastructure/payments/paystack';
import { billingService } from '../../application/billing/billing.service';

/**
 * Public Paystack webhook receiver: POST /api/webhooks/paystack
 *
 * Verifies the `x-paystack-signature` (HMAC-SHA512 over the raw body) before
 * processing. Always answers 200 quickly so Paystack does not retry; work is
 * done best-effort and re-verified against the Paystack API for integrity.
 */
export const paystackWebhookRoutes = Router();

paystackWebhookRoutes.post('/', (req, res) => {
  const signature = req.headers['x-paystack-signature'] as string | undefined;
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));

  if (!paystack.verifyWebhookSignature(raw, signature)) {
    logger.warn('Rejected Paystack webhook with invalid signature');
    res.sendStatus(401);
    return;
  }

  // Acknowledge immediately; process asynchronously.
  res.sendStatus(200);

  const event = req.body as { event: string; data?: { reference?: string } };
  void billingService.handleWebhookEvent(event).catch((err) => {
    logger.error({ err }, 'Paystack webhook processing failed');
  });
});
