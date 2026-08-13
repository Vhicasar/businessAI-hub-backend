import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { activityService } from '../crm/activity.service';
import { messagingService } from '../messaging/messaging.service';
import { pickChannelFor } from '../inbox/channel-allowance.service';
import { sendEmailViaChannel } from '../messaging/channel-email.service';
import { buildInvoiceDocument } from './invoice-document.service';
import type { ChannelType } from '@prisma/client';

/**
 * Sending an invoice to a customer, through the right channel.
 *
 * Creating an invoice used to mark it sent immediately, which meant the
 * business had no say in whether the customer was contacted or how. Creation
 * and delivery are separated here: the invoice exists, and sending it is a
 * decision with a channel attached.
 *
 * The channel matters. A business that set up a billing inbox does not want the
 * invoice going out of the support one, and `purpose` on each channel instance
 * is what makes that choice automatic but overridable.
 */

/** Channel types an invoice can meaningfully be delivered on. */
const DELIVERABLE: ChannelType[] = ['EMAIL', 'WHATSAPP', 'SMS'];

export interface DeliveryOption {
  /** Null for the platform fallback, which is not a business channel. */
  channelAccountId: string | null;
  channelType: string;
  name: string;
  purpose: string;
  /** The customer's address/number on this channel. */
  address: string;
  recommended: boolean;
  /**
   * True when the message goes out through Vhicasar's own mail server rather
   * than a channel the business connected. Surfaced so nobody is surprised
   * about which address the customer sees.
   */
  viaPlatform?: boolean;
}

/**
 * Why an invoice cannot be sent, when it cannot.
 *
 * Distinguished because the fixes are completely different, and reporting the
 * wrong one sends the user looking in the wrong place: `NO_CONTACT` means add
 * an email or phone to the customer, `NO_CHANNEL` means connect a channel.
 */
export type DeliveryBlocker = 'NO_CUSTOMER' | 'NO_CONTACT' | 'NO_CHANNEL' | null;

/**
 * Where this invoice could be sent, best first.
 *
 * Returns nothing when the customer has no usable contact details — the caller
 * says so plainly rather than pretending the invoice went out.
 */
export async function deliveryOptions(invoiceId: string): Promise<{
  invoice: { id: string; number: string; total: string; currency: string };
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  options: DeliveryOption[];
  blocked: DeliveryBlocker;
}> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    select: {
      id: true, number: true, total: true, currency: true,
      customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  });
  if (!invoice) throw new NotFoundError('Invoice');

  const customer = invoice.customer;
  const base = {
    invoice: {
      id: invoice.id,
      number: invoice.number,
      total: String(invoice.total),
      currency: invoice.currency,
    },
    customer: customer
      ? {
          id: customer.id,
          name: `${customer.firstName} ${customer.lastName ?? ''}`.trim(),
          email: customer.email,
          phone: customer.phone,
        }
      : null,
  };
  if (!customer) return { ...base, options: [], blocked: 'NO_CUSTOMER' };

  // Only channels the customer can actually be reached on.
  const reachable: ChannelType[] = [];
  if (customer.email) reachable.push('EMAIL');
  if (customer.phone) reachable.push('WHATSAPP', 'SMS');
  if (!reachable.length) return { ...base, options: [], blocked: 'NO_CONTACT' };

  const { recommended, eligible } = await pickChannelFor({
    purpose: 'INVOICES',
    channelTypes: reachable.filter((t) => DELIVERABLE.includes(t)),
  });

  const options: DeliveryOption[] = eligible.map((channel) => ({
    channelAccountId: channel.id,
    channelType: channel.channelType,
    name: channel.name,
    purpose: channel.purpose,
    address: channel.channelType === 'EMAIL' ? (customer.email ?? '') : (customer.phone ?? ''),
    recommended: channel.id === recommended?.id,
  }));

  /*
   * No platform fallback.
   *
   * An invoice is the business speaking to its own customer, so it goes out of
   * the business's address or it does not go out — see `sender-policy`. When
   * nothing is connected the caller is told to connect one, which is a small
   * one-off setup rather than every future invoice arriving from an address the
   * customer does not recognise and cannot reply to.
   */
  return { ...base, options, blocked: options.length ? null : 'NO_CHANNEL' };
}

/**
 * Send the invoice on a chosen channel and record what happened.
 *
 * Delivery status is recorded whether it succeeded or not: a business needs to
 * know an invoice failed to reach the customer far more than it needs a clean
 * timeline.
 */
export async function deliverInvoice(input: {
  invoiceId: string;
  /** Omit, or pass null, to use the platform email fallback. */
  channelAccountId?: string | null;
}): Promise<{ sent: boolean; channel: DeliveryOption | null; error: string | null }> {
  const { invoice, customer, options, blocked } = await deliveryOptions(input.invoiceId);
  if (!customer) throw new ValidationError('This invoice has no customer to send to');
  if (!options.length) {
    // Say which problem it is. Telling someone their customer has no email when
    // the customer plainly does sends them looking in the wrong place.
    throw new ValidationError(
      blocked === 'NO_CONTACT'
        ? `${customer.name} has no email address or phone number on record, so there is no way to send this invoice.`
        : 'No channel is connected that can send this invoice. Connect an email, WhatsApp or SMS channel in Settings → Integrations.',
    );
  }

  const channel = input.channelAccountId
    ? options.find((o) => o.channelAccountId === input.channelAccountId)
    : options.find((o) => o.recommended) ?? options[0];
  if (!channel) throw new ValidationError('That channel is not available for this invoice');

  const amount = `${invoice.currency} ${Number(invoice.total).toLocaleString()}`;

  // The invoice itself — line items, totals, what is due — plus a PDF. A
  // one-line "your invoice is ready" is a notification, not an invoice.
  const document = await buildInvoiceDocument(input.invoiceId).catch((err) => {
    logger.warn({ err: (err as Error).message, invoiceId: input.invoiceId }, 'invoice document not built');
    return null;
  });

  let outcome: { ok: boolean; error?: string };
  if (channel.channelType === 'EMAIL' && document) {
    // Email carries the whole document and the PDF, through the business's own
    // connected mailbox.
    outcome = await sendInvoiceEmail(channel, document);
  } else {
    // WhatsApp and SMS cannot carry an attachment, so they get a summary and
    // are told the invoice follows by email.
    const summary = document
      ? `${document.text}`.slice(0, 900)
      : `Invoice ${invoice.number} for ${amount} is ready.`;
    outcome = await messagingService.sendToCustomer(
      customer.id,
      channel.channelType as ChannelType,
      summary,
      { subject: document?.subject ?? `Invoice ${invoice.number}` },
    );
  }

  const dbInvoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, deletedAt: null },
    select: { id: true, dealId: true, status: true },
  });

  // Only a delivered invoice becomes "sent" — marking it sent when the message
  // bounced is how a business ends up chasing a customer who never got it.
  if (outcome.ok && dbInvoice?.status === 'DRAFT') {
    await prisma.invoice.update({
      where: { id: input.invoiceId },
      data: { status: 'SENT', issuedAt: new Date() },
    });
  }

  const title = outcome.ok
    ? `Invoice ${invoice.number} sent via ${channel.name}`
    : `Invoice ${invoice.number} could not be sent via ${channel.name}`;

  await activityService
    .record({
      type: 'SYSTEM',
      entityType: 'CUSTOMER',
      entityId: customer.id,
      title,
      body: [
        `Channel: ${channel.name} (${channel.channelType})`,
        `Purpose: ${channel.purpose}`,
        `To: ${channel.address}`,
        outcome.ok ? 'Delivered.' : `Failed: ${outcome.error ?? 'unknown error'}`,
      ].join('\n'),
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        channelAccountId: channel.channelAccountId,
        channelType: channel.channelType,
        channelPurpose: channel.purpose,
        deliveryStatus: outcome.ok ? 'DELIVERED' : 'FAILED',
        error: outcome.ok ? null : outcome.error ?? null,
      },
      // The deal's timeline is where a salesperson looks, so record it there too.
      also: dbInvoice?.dealId ? [{ entityType: 'DEAL', entityId: dbInvoice.dealId }] : undefined,
    })
    .catch((err) => logger.warn({ err, invoiceId: invoice.id }, 'invoice delivery not recorded'));

  return {
    sent: outcome.ok,
    channel,
    error: outcome.ok ? null : outcome.error ?? 'Delivery failed',
  };
}

/**
 * Email the invoice with its PDF attached, from the business's own mailbox.
 *
 * Sent through the connected channel's SMTP credentials rather than the
 * platform transport, so the customer sees the business's address and can
 * reply to it (see `sender-policy`).
 */
async function sendInvoiceEmail(
  channel: DeliveryOption,
  document: { subject: string; html: string; text: string; pdf: Buffer; filename: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!channel.channelAccountId) {
    return { ok: false, error: 'No email channel is connected to send this invoice from' };
  }
  try {
    return await sendEmailViaChannel(channel.channelAccountId, {
      to: channel.address,
      subject: document.subject,
      html: document.html,
      text: document.text,
      attachments: [{ filename: document.filename, content: document.pdf, contentType: 'application/pdf' }],
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
  }
}
