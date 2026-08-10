import { randomUUID } from 'node:crypto';
import type { ChannelType } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { messagingService } from '../messaging/messaging.service';
import { notifyCustomer } from '../notifications/notify';
import { readPaymentSettings } from './payment-settings.service';
import { receiptNumberFor } from './payment-receipt.service';
import { publicPayUrl } from './payment-intent.service';

/**
 * Telling the customer their payment landed.
 *
 * Only on the channels the business has switched on (§8). A business that has
 * not enabled WhatsApp does not get to have WhatsApp messages sent in its name
 * because a payment happened to arrive.
 *
 * Every channel is independently best-effort: a bounced email must not stop the
 * push notification, and neither can affect the payment itself.
 */

export async function notifyPaymentReceived(intentId: string): Promise<void> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent || !intent.token) return;

  const settings = await readPaymentSettings(intent.organizationId);
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: intent.organizationId },
    select: { name: true },
  });
  const businessName = org?.name ?? 'Vhicasar Hub AI';
  const amount = `${intent.currency} ${Number(intent.amountPaid).toFixed(2)}`;
  const receiptNumber = receiptNumberFor(intent.reference);
  const receiptUrl = `${publicPayUrl(intent.token)}/receipt`;
  const what = intent.description ? ` for ${intent.description}` : '';

  const text =
    `Payment confirmed — ${amount}${what}.\n` +
    `Receipt ${receiptNumber}: ${receiptUrl}\n— ${businessName}`;

  // The messaging layer is tenant-scoped and this runs from a webhook with no
  // request context, so a context is established for the send.
  if (intent.customerId) {
    const channels: { on: boolean; channel: ChannelType }[] = [
      { on: settings.notifyEmail, channel: 'EMAIL' },
      { on: settings.notifySms, channel: 'SMS' },
      { on: settings.notifyWhatsapp, channel: 'WHATSAPP' },
      { on: settings.notifyInbox, channel: 'WEB_CHAT' },
    ];
    const enabled = channels.filter((c) => c.on).map((c) => c.channel);

    if (enabled.length > 0) {
      await requestContext.run(
        { requestId: randomUUID(), organizationId: intent.organizationId },
        async () => {
          for (const channel of enabled) {
            await messagingService
              .sendToCustomer(intent.customerId!, channel, text, {
                subject: `Receipt ${receiptNumber} — ${businessName}`,
              })
              .catch((err) =>
                logger.warn(
                  { err: (err as Error).message, channel, intentId },
                  'payment confirmation channel failed'
                )
              );
          }
        }
      );
    }
  }

  // In-app: a push and a row in the customer's activity centre, deep-linked to
  // the payment so tapping it opens the receipt rather than the app's home.
  if (settings.notifyPush && intent.customerId) {
    const link = await prismaUnscoped.customerLink.findFirst({
      where: { customerId: intent.customerId, organizationId: intent.organizationId },
      select: { vhicasarId: true },
    });
    if (link?.vhicasarId) {
      await notifyCustomer({
        vhicasarId: link.vhicasarId,
        organizationId: intent.organizationId,
        category: 'PAYMENT',
        title: 'Payment successful',
        body: `${amount} to ${businessName}`,
        deeplink: `vhicasar://payments/${intent.reference}`,
        data: { paymentIntentId: intent.id, reference: intent.reference, receiptNumber },
      }).catch((err) =>
        logger.warn({ err: (err as Error).message, intentId }, 'payment push failed')
      );
    }
  }
}
