import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { pickChannelFor } from '../inbox/channel-allowance.service';
import { channelCanSendEmail, sendEmailViaChannel } from '../messaging/channel-email.service';
import { CONNECT_CHANNEL_HINT } from '../messaging/sender-policy';
import { readPaymentSettings } from './payment-settings.service';
import { buildReceiptForIntent, renderReceiptHtml, renderReceiptText } from './receipt-document.service';
import { publicPayUrl } from './payment-intent.service';

/**
 * Emailing the receipt — and being honest about whether it went.
 *
 * This used to ride on `messagingService.sendToCustomer`, which needs a
 * connected EMAIL channel, needs the payment to carry a customer id, and
 * returns a failure that nobody read. Payment links frequently have no
 * customer, most businesses have no EMAIL channel, and the address the
 * customer typed into the pay page was handed to the gateway and thrown away.
 * So the setting said "issue a receipt automatically", the customer was told
 * their receipt was on its way, and nothing was ever sent.
 *
 * The fixes are all here: a recipient resolved from the order's own checkout
 * details first, a real document rather than a line of text, a recorded
 * outcome, and a status the pay page can show instead of a promise.
 *
 * The receipt still goes out of the *business's* mailbox, never Vhicasar's —
 * see sender-policy. A business with no channel connected is told so plainly
 * and the customer is given the link instead.
 */

export type ReceiptEmailStatus =
  /** Sent to the business's mail server, which accepted it. */
  | 'SENT'
  /** Nowhere to send it: no address was given and none is on file. */
  | 'NO_RECIPIENT'
  /** The business has not connected a mailbox to send from. */
  | 'NO_CHANNEL'
  /** Tried and failed. Retryable. */
  | 'FAILED'
  /** The business has automatic receipts switched off. */
  | 'DISABLED'
  /** Already sent for this payment; nothing more to do. */
  | 'ALREADY_SENT';

export interface ReceiptEmailOutcome {
  status: ReceiptEmailStatus;
  recipient: string | null;
  /** Shown to a customer or a business user; never a stack trace. */
  message: string;
  /** Where the receipt can be read regardless of what the email did. */
  receiptUrl: string | null;
  attempts: number;
}

/** An address that is at least shaped like one. */
function usableEmail(value: string | null | undefined): string | null {
  const clean = value?.trim().toLowerCase();
  if (!clean) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : null;
}

/**
 * Who the receipt is for.
 *
 * In order of how much the customer meant it: what they typed for this order,
 * what they typed into the pay box, then whatever the profile has. A profile
 * address is a reasonable last resort but a poor first choice — the person
 * paying may not be the person the profile belongs to.
 */
async function resolveRecipient(intent: {
  id: string;
  orderId: string | null;
  invoiceId: string | null;
  customerId: string | null;
  metadata: unknown;
}): Promise<{ email: string | null; name: string | null }> {
  let orderId = intent.orderId;
  if (!orderId && intent.invoiceId) {
    const invoice = await prismaUnscoped.invoice.findUnique({
      where: { id: intent.invoiceId },
      select: { orderId: true },
    });
    orderId = invoice?.orderId ?? null;
  }
  const order = orderId
    ? await prismaUnscoped.order.findUnique({
        where: { id: orderId },
        select: { contactEmail: true, contactName: true },
      })
    : null;

  const metadata = (intent.metadata as Record<string, unknown>) ?? {};
  const customer = intent.customerId
    ? await prismaUnscoped.customer.findUnique({
        where: { id: intent.customerId },
        select: { email: true, firstName: true, lastName: true },
      })
    : null;

  const email =
    usableEmail(order?.contactEmail) ??
    usableEmail(metadata.checkoutEmail as string | undefined) ??
    usableEmail(customer?.email);

  const name =
    order?.contactName?.trim() ||
    (customer ? `${customer.firstName} ${customer.lastName ?? ''}`.trim() : null) ||
    null;

  return { email, name };
}

/** Record every attempt, successful or not, so a business can see what happened. */
async function record(
  organizationId: string,
  recipient: string,
  subject: string,
  outcome: { delivered: boolean; attempts: number; error?: string },
): Promise<void> {
  await prismaUnscoped.emailDeliveryLog
    .create({
      data: {
        organizationId,
        type: 'RECEIPT',
        recipient,
        subject,
        status: outcome.delivered ? 'SENT' : 'FAILED',
        attempts: outcome.attempts,
        provider: 'business-channel',
        error: outcome.error ?? null,
      },
    })
    .catch((err) => logger.warn({ err: (err as Error).message }, 'receipt delivery log not written'));
}

async function remember(intentId: string, outcome: ReceiptEmailOutcome): Promise<void> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({
    where: { id: intentId },
    select: { metadata: true },
  });
  const metadata = ((intent?.metadata as Record<string, unknown>) ?? {});
  await prismaUnscoped.paymentIntent.update({
    where: { id: intentId },
    data: {
      metadata: {
        ...metadata,
        receiptEmail: {
          status: outcome.status,
          recipient: outcome.recipient,
          attempts: outcome.attempts,
          at: new Date().toISOString(),
          message: outcome.message,
        },
      } as Prisma.InputJsonValue,
    },
  });
}

/** What the last attempt did, for the pay page and the order screen. */
export async function receiptEmailState(intentId: string): Promise<ReceiptEmailOutcome | null> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({
    where: { id: intentId },
    select: { metadata: true, token: true },
  });
  const stored = ((intent?.metadata as Record<string, any>) ?? {}).receiptEmail;
  if (!stored) return null;
  return {
    status: stored.status,
    recipient: stored.recipient ?? null,
    message: stored.message ?? '',
    receiptUrl: intent?.token ? `${publicPayUrl(intent.token)}/receipt` : null,
    attempts: Number(stored.attempts ?? 0),
  };
}

export interface SendReceiptOptions {
  /** Send again even though one already went. Only ever on an explicit ask. */
  force?: boolean;
}

export async function sendReceiptEmail(
  intentId: string,
  options: SendReceiptOptions = {},
): Promise<ReceiptEmailOutcome> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) {
    return { status: 'FAILED', recipient: null, message: 'That payment could not be found.', receiptUrl: null, attempts: 0 };
  }
  const receiptUrl = intent.token ? `${publicPayUrl(intent.token)}/receipt` : null;
  const previous = ((intent.metadata as Record<string, any>) ?? {}).receiptEmail as
    | { status: ReceiptEmailStatus; attempts?: number }
    | undefined;
  const attempts = Number(previous?.attempts ?? 0);

  const base = (status: ReceiptEmailStatus, message: string, recipient: string | null = null): ReceiptEmailOutcome => ({
    status,
    recipient,
    message,
    receiptUrl,
    attempts,
  });

  // A replayed webhook, a reconciliation sweep and a manual re-check all land
  // here. One payment, one receipt.
  if (previous?.status === 'SENT' && !options.force) {
    return base('ALREADY_SENT', 'The receipt has already been emailed.');
  }

  const settings = await readPaymentSettings(intent.organizationId);
  if (!settings.autoReceipts || !settings.notifyEmail) {
    return base('DISABLED', 'Automatic receipt emails are switched off for this business.');
  }
  // Only a payment the provider has confirmed produces a receipt.
  if (intent.status !== 'PAID' && intent.status !== 'OVERPAID') {
    return base('FAILED', 'A receipt is only issued once the payment has been confirmed.');
  }

  const { email, name } = await resolveRecipient(intent);
  if (!email) {
    const outcome = base(
      'NO_RECIPIENT',
      receiptUrl
        ? 'No email address was given for this payment, so the receipt could not be sent. The receipt link still works.'
        : 'No email address was given for this payment, so the receipt could not be sent.',
    );
    await remember(intentId, outcome);
    return outcome;
  }

  // The receipt is the business speaking to its own customer, so it leaves
  // from the business's mailbox or it does not leave. See sender-policy.
  const { recommended, eligible } = await requestContext.run(
    { requestId: randomUUID(), organizationId: intent.organizationId } as never,
    () => pickChannelFor({ purpose: 'INVOICES', channelTypes: ['EMAIL'] }),
  );
  const channel = recommended ?? eligible[0];
  if (!channel) {
    const outcome = base(
      'NO_CHANNEL',
      `This payment's receipt could not be emailed: no mailbox is connected to send it from. ${CONNECT_CHANNEL_HINT}`,
      email,
    );
    await remember(intentId, outcome);
    return outcome;
  }

  const receipt = await buildReceiptForIntent(intent.id);
  const subject = `Receipt ${receipt.receiptNumber} — ${receipt.business.name}`;
  const html = await renderReceiptHtml(receipt);
  const text = [renderReceiptText(receipt), receiptUrl ? `\nView this receipt online: ${receiptUrl}` : '']
    .filter(Boolean)
    .join('\n');

  const sent = await sendEmailViaChannel(channel.id, {
    to: email,
    subject,
    html,
    text,
  });

  const next = attempts + 1;
  await record(intent.organizationId, email, subject, {
    delivered: sent.ok,
    attempts: next,
    error: sent.error,
  });

  const outcome: ReceiptEmailOutcome = sent.ok
    ? {
        status: 'SENT',
        recipient: email,
        // Accepted by a mail server is not the same as landed in an inbox, and
        // saying otherwise is a promise nobody here can keep.
        message: `Receipt sent to ${email}.`,
        receiptUrl,
        attempts: next,
      }
    : {
        status: 'FAILED',
        recipient: email,
        message: sent.error ?? 'The receipt could not be sent. It can be retried.',
        receiptUrl,
        attempts: next,
      };

  await remember(intentId, outcome);
  if (!sent.ok) {
    logger.warn({ intentId, error: sent.error }, 'receipt email failed; retryable');
  }
  return outcome;
}

/**
 * Whether a receipt *could* be emailed, asked before anything is promised.
 *
 * The settings page used to say "issue a receipt automatically" and stop
 * there. This is what lets it say whether that will actually happen.
 */
export async function receiptEmailReadiness(organizationId: string): Promise<{
  enabled: boolean;
  channelConnected: boolean;
  message: string;
}> {
  const settings = await readPaymentSettings(organizationId);
  const enabled = settings.autoReceipts && settings.notifyEmail;
  const { recommended, eligible } = await requestContext.run(
    { requestId: randomUUID(), organizationId } as never,
    () => pickChannelFor({ purpose: 'INVOICES', channelTypes: ['EMAIL'] }),
  );
  const channel = recommended ?? eligible[0];
  // Connected is not the same as able to send: a mailbox set up for reading
  // has no outgoing server, and saying "receipts will be emailed" of one is
  // the same promise that was being broken before.
  const capability = channel ? await channelCanSendEmail(channel.id) : { ok: false, reason: null };
  return {
    enabled,
    channelConnected: capability.ok,
    message: !enabled
      ? 'Automatic receipt emails are off. Customers can still open the receipt link.'
      : capability.ok
        ? 'Receipts will be emailed from your connected mailbox.'
        : channel
          ? `Receipts cannot be emailed yet: ${capability.reason}`
          : `Receipts cannot be emailed yet: no mailbox is connected. ${CONNECT_CHANNEL_HINT}`,
  };
}
