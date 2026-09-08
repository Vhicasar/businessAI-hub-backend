import { Router } from 'express';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { smsProvider } from '../../infrastructure/sms/registry';
import { smsSendService } from '../../application/sms/sms-send.service';
import { logger } from '../../shared/logger';
import type { SmsMessageStatus } from '@prisma/client';

/**
 * Delivery receipts from the SMS provider.
 *
 * Public and unauthenticated in the usual sense — the provider has no Vhicasar
 * session — so the signature is the only thing standing between a stranger and
 * the ability to mark a business's messages delivered. An unsigned or
 * unverifiable delivery is dropped.
 *
 * Always answers 200. Providers retry on anything else, and a retry storm over
 * a receipt we already have helps nobody.
 */
export const smsWebhookRoutes = Router();

/** Later states win; a receipt that arrives out of order is ignored. */
const RANK: Record<SmsMessageStatus, number> = {
  QUEUED: 0, SENT: 1, DELIVERED: 2,
  // Terminal outcomes outrank delivery: they can only arrive after a send, and
  // once a message is rejected it is not going to become delivered.
  FAILED: 3, REJECTED: 3, EXPIRED: 3,
};

smsWebhookRoutes.post('/delivery', (req, res) => {
  res.status(200).json({ ok: true });

  void (async () => {
    try {
      const provider = smsProvider();
      const verified = provider.verifyWebhook({
        headers: req.headers,
        body: req.body,
        rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
      });
      if (!verified) {
        logger.warn({ path: req.path }, 'SMS webhook signature verification failed');
        return;
      }

      for (const report of provider.parseWebhook(req.body)) {
        // Found by our own reference where the provider echoes it, because a
        // bulk send shares one provider id across every recipient in it.
        const message = report.reference
          ? await prismaUnscoped.smsMessage.findFirst({
              where: { reference: report.reference },
              select: { id: true, status: true, organizationId: true, recipient: true },
            })
          : await prismaUnscoped.smsMessage.findFirst({
              where: { providerMessageId: report.providerMessageId },
              select: { id: true, status: true, organizationId: true, recipient: true },
            });

        // A receipt for something we did not send — an old message, or another
        // system sharing the provider account.
        if (!message) continue;

        // Idempotent: replaying a webhook cannot move a message backwards, and
        // re-delivering the same receipt changes nothing at all.
        if ((RANK[report.status] ?? 0) <= (RANK[message.status] ?? 0)) continue;

        const at = report.occurredAt ?? new Date();
        await prismaUnscoped.smsMessage.update({
          where: { id: message.id },
          data: {
            status: report.status,
            ...(report.status === 'DELIVERED' ? { deliveredAt: at } : {}),
            ...(report.providerCost !== undefined ? { providerCost: report.providerCost } : {}),
            // The provider's wording, kept for support rather than shown.
            ...(report.rawReason ? { failureReason: report.rawReason } : {}),
          },
        });

        /*
         * A number the network refused is a number to stop marketing to.
         *
         * REJECTED on a Nigerian network usually means Do-Not-Disturb, and
         * continuing to pay to text somebody who cannot receive it is money
         * spent to annoy nobody.
         */
        if (report.status === 'REJECTED') {
          await smsSendService.suppress(
            message.organizationId,
            message.recipient,
            'Rejected by the network',
            message.id,
          );
        }
      }
    } catch (err) {
      logger.error({ err, path: req.path }, 'SMS delivery webhook failed');
    }
  })();
});
