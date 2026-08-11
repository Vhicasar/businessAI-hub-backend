import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { paymentIntentService } from './payment-intent.service';
import { env } from '../../shared/config/env';
import { requestContext } from '../../shared/context';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * The pay code printed on a bill.
 *
 * A customer holding an invoice, a receipt with a balance, or a rent demand
 * should be able to settle it by pointing a phone at the page. This issues the
 * payment link that makes that possible and hands back what to print.
 *
 * ## What the code encodes, and why
 *
 * The public pay URL — the same one the business would text or email. One code
 * therefore serves everybody: a customer with the Super App scans it in-app and
 * pays from their wallet; a customer without it gets the hosted page in their
 * camera's browser. A custom `vhicasar://` scheme would have been dead paper
 * for the second group.
 *
 * ## Security
 *
 * The token is the bearer credential: whoever holds the paper can pay the bill.
 * That is the intended trust model — it is *their* bill — but it means the code
 * must reveal nothing else and must not be usable for anything else:
 *
 * - **Server-authoritative amount.** The link is created from the resource's own
 *   outstanding balance. Nothing in the request influences what is charged.
 * - **Nothing issued for a settled or dead bill.** A paid, cancelled or voided
 *   record has no outstanding balance, so no code is printed at all.
 * - **No personal data in the code.** It carries an opaque token, not a name,
 *   phone number, customer id or amount. A photographed invoice leaks no more
 *   than the invoice already does.
 * - **Reuse, not re-issue.** An open link for the same record is returned again
 *   rather than a second one minted, so reprinting a bill cannot end with two
 *   live codes and a double payment.
 * - **Expiry.** Printed paper outlives its usefulness; a code left on a
 *   noticeboard should stop working.
 * - **Suspended businesses cannot collect.** Checked here *and* on the public
 *   view, because the org's standing can change between printing and scanning.
 * - **Tenant isolation.** The resource is loaded within the caller's own
 *   organization, so no document can be made to point at another business.
 */

/**
 * What can carry a printed pay code.
 *
 * Only two, because only two things in this system hold a balance: an order and
 * an invoice. Property and rent charges *are* invoices — one bound to a lease —
 * so they are covered by `INVOICE` and simply labelled as rent when a lease is
 * behind them, rather than invented as a third kind that would have no rows.
 */
export const DOCUMENT_RESOURCES = ['ORDER', 'INVOICE'] as const;
export type DocumentResource = (typeof DOCUMENT_RESOURCES)[number];

export const documentQrSchema = z.object({
  resourceType: z.enum(DOCUMENT_RESOURCES),
  resourceId: z.string().min(1),
});

/**
 * How long a printed code stays live. Long enough for a bill to be paid in the
 * ordinary course, short enough that an old invoice in a drawer is not a
 * standing instruction to pay.
 */
const PRINTED_CODE_TTL_DAYS = 90;

export interface DocumentPaymentQr {
  /** False when the business has turned printed codes off. */
  enabled: boolean;
  /** Null when there is nothing to pay, or codes are off. */
  payload: string | null;
  token: string | null;
  amount: string | null;
  currency: string | null;
  description: string | null;
  /** Why no code was produced, for the operator rather than the customer. */
  reason: string | null;
}

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

const money = (d: Prisma.Decimal) => d.toFixed(2);
const publicUrl = (token: string) => `${env.WEB_APP_URL.replace(/\/+$/, '')}/pay/${token}`;

interface Payable {
  outstanding: Prisma.Decimal;
  currency: string;
  description: string;
  customerId: string | null;
  dead: boolean;
}

/**
 * What a document owes, whatever kind of document it is. Each branch reads the
 * resource's own totals — never a figure supplied by the caller.
 */
async function payableFor(
  organizationId: string,
  resourceType: DocumentResource,
  resourceId: string
): Promise<Payable> {
  switch (resourceType) {
    case 'ORDER': {
      const order = await prismaUnscoped.order.findFirst({
        where: { id: resourceId, organizationId },
        select: {
          number: true, total: true, currency: true, status: true, customerId: true,
          payments: { where: { status: 'PAID' }, select: { amount: true } },
        },
      });
      if (!order) throw new NotFoundError('Order');
      const paid = order.payments.reduce((s, p) => s.plus(p.amount), new Prisma.Decimal(0));
      return {
        outstanding: order.total.minus(paid),
        currency: order.currency,
        description: `Order ${order.number}`,
        customerId: order.customerId,
        dead: order.status === 'CANCELLED' || order.status === 'REFUNDED',
      };
    }

    case 'INVOICE': {
      const invoice = await prismaUnscoped.invoice.findFirst({
        where: { id: resourceId, organizationId },
        select: {
          number: true, total: true, amountPaid: true, currency: true, status: true,
          customerId: true,
          // A rent demand is an invoice with a lease behind it. Reading the
          // lease lets the payment say "Rent for 12 Marina Way" on the
          // customer's statement rather than an invoice number they will not
          // recognise a month later.
          lease: { select: { number: true, property: { select: { title: true } } } },
        },
      });
      if (!invoice) throw new NotFoundError('Invoice');
      const label = invoice.lease
        ? `Rent — ${invoice.lease.property?.title ?? invoice.lease.number}`
        : `Invoice ${invoice.number}`;
      return {
        outstanding: invoice.total.minus(invoice.amountPaid),
        currency: invoice.currency,
        description: label,
        customerId: invoice.customerId,
        // An invoice has no CANCELLED state; VOID is how one is killed.
        dead: invoice.status === 'VOID',
      };
    }
  }
}

export const documentPayment = {
  DOCUMENT_RESOURCES,

  /**
   * The pay code for one document, creating the payment link if this is the
   * first time the document has been printed.
   *
   * Never throws for the ordinary "nothing to pay" cases — a receipt for a
   * settled order should print without a code, not fail to print.
   */
  async qrFor(
    resourceType: DocumentResource,
    resourceId: string,
    organizationId?: string
  ): Promise<DocumentPaymentQr> {
    const orgId = organizationId ?? currentOrgId();
    const off = (reason: string, enabled = true): DocumentPaymentQr => ({
      enabled, payload: null, token: null, amount: null, currency: null, description: null, reason,
    });

    const org = await prismaUnscoped.organization.findUnique({
      where: { id: orgId },
      select: { paymentQrOnDocuments: true, status: true, deletedAt: true },
    });
    if (!org) throw new NotFoundError('Business');
    if (!org.paymentQrOnDocuments) {
      return off('Pay codes on documents are turned off for this business.', false);
    }
    // A business that is suspended or closed must not be able to keep
    // collecting through freshly printed paper.
    if (org.deletedAt || (org.status !== 'ACTIVE' && org.status !== 'TRIAL')) {
      return off('This business cannot currently take payments.');
    }

    const payable = await payableFor(orgId, resourceType, resourceId);
    if (payable.dead) return off('This record is cancelled, so there is nothing to pay.');
    if (!payable.outstanding.greaterThan(0)) return off('This is settled — nothing left to pay.');

    // Reuse an open intent rather than minting a second one: reprinting a bill
    // must not leave two live codes against the same debt. `create` handles the
    // reuse, including standing down a stale one whose amount has moved.
    //
    // A Payment Intent, not a payment link — the /pay/<token> page resolves
    // intents, so a code backed by anything else scans to "payment not found".
    const intent = await paymentIntentService.create({
      organizationId: orgId,
      resourceType: resourceType === 'ORDER' ? 'ORDER' : 'INVOICE',
      resourceId,
      customerId: payable.customerId,
      orderId: resourceType === 'ORDER' ? resourceId : null,
      invoiceId: resourceType === 'INVOICE' ? resourceId : null,
      // The resource's own balance, never anything from the request.
      amount: Number(payable.outstanding),
      currency: payable.currency,
      description: payable.description,
      // Part payment is allowed: someone paying a large bill in instalments
      // should not be forced to the full amount by the printed code.
      allowPartial: true,
      channel: 'QR',
      // Paper outlives a screen, so a printed code is given a long life — but
      // not an unlimited one.
      expiryMinutes: PRINTED_CODE_TTL_DAYS * 24 * 60,
    });

    return {
      enabled: true,
      payload: publicUrl(intent.token!),
      token: intent.token,
      amount: money(payable.outstanding),
      currency: intent.currency,
      description: intent.description,
      reason: null,
    };
  },

  /**
   * Best-effort variant for document rendering. A code is a convenience on a
   * bill, so a failure to mint one must never stop the bill printing.
   */
  async qrForSafe(
    resourceType: DocumentResource,
    resourceId: string,
    organizationId?: string
  ): Promise<DocumentPaymentQr> {
    try {
      return await this.qrFor(resourceType, resourceId, organizationId);
    } catch (err) {
      logger.warn({ err, resourceType, resourceId }, 'document pay code unavailable');
      return {
        enabled: true, payload: null, token: null, amount: null,
        currency: null, description: null, reason: 'Could not produce a pay code.',
      };
    }
  },

  /** Read the business's toggle. */
  async getSetting(): Promise<{ paymentQrOnDocuments: boolean }> {
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: currentOrgId() },
      select: { paymentQrOnDocuments: true },
    });
    if (!org) throw new NotFoundError('Business');
    return { paymentQrOnDocuments: org.paymentQrOnDocuments };
  },

  /**
   * Turn printed pay codes on or off.
   *
   * Turning them off does not cancel codes already in customers' hands: those
   * are live debts someone may be about to settle, and killing them would
   * bounce a legitimate payment. It only stops new documents carrying one.
   */
  async setSetting(enabled: boolean): Promise<{ paymentQrOnDocuments: boolean }> {
    const org = await prismaUnscoped.organization.update({
      where: { id: currentOrgId() },
      data: { paymentQrOnDocuments: enabled },
      select: { paymentQrOnDocuments: true },
    });
    return { paymentQrOnDocuments: org.paymentQrOnDocuments };
  },
};

// Tokens are minted by the intent service now — one place decides what a
// bearer credential looks like.

export { AppError, ForbiddenError };
