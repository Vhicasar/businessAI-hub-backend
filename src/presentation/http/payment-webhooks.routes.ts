import { Router, type Request, type Response } from 'express';
import { logger } from '../../shared/logger';
import { resolveWebhookTarget } from '../../application/payments/org-account.service';
import { paymentWebhookService } from '../../application/payments/payment-webhook.service';

/**
 * Per-business payment webhooks:
 *
 *   POST /api/webhooks/payments/:provider/:webhookId
 *
 * Each business collects through its own gateway account with its own signing
 * secret, so there is one endpoint per business rather than one per provider.
 * The id in the path is what lets us fetch the right secret *before* trusting
 * anything in the body — a single shared endpoint would have to guess.
 *
 * Always answers 200 to anything that verifies, immediately, and does the work
 * after: a provider that does not get a prompt acknowledgement retries, and a
 * slow handler turns one payment into five deliveries.
 */
export const paymentWebhookRoutes = Router();

const SIGNATURE_HEADERS: Record<string, string> = {
  paystack: 'x-paystack-signature',
  flutterwave: 'verif-hash',
  stripe: 'stripe-signature',
  moniepoint: 'monnify-signature',
  // OPay carries its signature inside the callback body rather than a header;
  // the adapter reads it from there, so the header lookup finds nothing and
  // that is expected.
  opay: 'authorization',
};

paymentWebhookRoutes.post('/:provider/:webhookId', async (req: Request, res: Response) => {
  const provider = String(req.params.provider ?? '').toLowerCase();
  const webhookId = String(req.params.webhookId ?? '');
  const headerName = SIGNATURE_HEADERS[provider];

  if (!headerName) {
    res.status(404).json({ success: false, error: { code: 'UNKNOWN_PROVIDER' } });
    return;
  }

  const target = await resolveWebhookTarget(webhookId);
  if (!target || target.providerName !== provider) {
    // Deliberately vague and slow to distinguish from a signature failure: a
    // prober should not be able to tell a real endpoint from a wrong secret.
    logger.warn({ provider, webhookId: webhookId.slice(0, 6) }, 'payment webhook for unknown endpoint');
    res.sendStatus(404);
    return;
  }

  const signature = req.headers[headerName] as string | undefined;
  const raw =
    (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  let signatureValid = false;
  try {
    signatureValid = target.provider.verifyWebhookSignature(raw, signature);
  } catch (err) {
    logger.warn({ err: (err as Error).message, provider }, 'signature verification threw');
  }

  // Recorded either way — an endpoint being fed forged events is something an
  // operator needs to be able to see — but a bad signature is never processed.
  if (!signatureValid) {
    void paymentWebhookService
      .ingest({ provider, organizationId: target.organizationId, body: req.body, signatureValid: false })
      .catch(() => undefined);
    res.sendStatus(401);
    return;
  }

  res.sendStatus(200);

  void paymentWebhookService
    .ingest({
      provider,
      organizationId: target.organizationId,
      body: req.body,
      signatureValid: true,
    })
    .catch((err) =>
      logger.error({ err, provider, organizationId: target.organizationId }, 'payment webhook ingest failed')
    );
});
