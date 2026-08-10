import type { PaymentMethodType } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { readPaymentSettings } from './payment-settings.service';

/**
 * What happens to the rest of the business when a payment lands.
 *
 * One path, for every kind of payable thing and every surface a payment can be
 * started from. Before this, an order paid by link and an order paid in the app
 * updated different records in different orders, and the two drifted.
 *
 * Two properties matter more than anything else here:
 *
 *  * it is **idempotent** — a provider retry, a reconciliation sweep and a
 *    manual re-check can all call it and the customer is emailed once, stock
 *    moves once, and the deal is credited once;
 *  * it is **best-effort per step** — a failing notification must never undo a
 *    payment that has genuinely been received. Each step is isolated and logged.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPSILON = 0.005;

/** Our payment-method vocabulary mapped to the accounting one. */
const ACCOUNTING_METHOD: Record<string, PaymentMethodType> = {
  CARD: 'CARD',
  BANK_TRANSFER: 'BANK_TRANSFER',
  VIRTUAL_ACCOUNT: 'BANK_TRANSFER',
  PAY_WITH_BANK: 'BANK_TRANSFER',
  USSD: 'ONLINE_GATEWAY',
  QR_CODE: 'ONLINE_GATEWAY',
  MOBILE_MONEY: 'MOBILE_MONEY',
  WALLET: 'WALLET',
  PAYMENT_LINK: 'ONLINE_GATEWAY',
  DIRECT_DEBIT: 'BANK_TRANSFER',
  APPLE_PAY: 'CARD',
  GOOGLE_PAY: 'CARD',
  PAYPAL: 'ONLINE_GATEWAY',
  CRYPTO: 'ONLINE_GATEWAY',
  CASH_ON_DELIVERY: 'COD',
};

async function step(name: string, intentId: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Deliberately swallowed. The money is real whatever happens here; an
    // exception would roll the caller back and lose a confirmed payment.
    logger.error({ err: (err as Error).message, intentId, step: name }, 'payment settlement step failed');
  }
}

export interface SettleOptions {
  /** True only on the transition into a fully-paid state. */
  becamePaid: boolean;
}

/**
 * Fan a confirmed payment out across the business.
 *
 * Safe to call more than once for the same intent: every write below is either
 * an upsert keyed on something stable, or a recomputation from the ledger.
 */
export async function settlePaymentIntent(
  intentId: string,
  opts: SettleOptions = { becamePaid: false }
): Promise<void> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) return;

  const settings = await readPaymentSettings(intent.organizationId);
  const paid = Number(intent.amountPaid);

  // 1. Accounting record. Keyed on the intent so a replay updates rather than
  //    duplicates — this is what stops a retried webhook double-counting
  //    revenue in every report the business runs.
  await step('payment-record', intentId, async () => {
    const existing = await prismaUnscoped.payment.findFirst({
      where: { paymentIntentId: intent.id },
      select: { id: true },
    });
    const data = {
      organizationId: intent.organizationId,
      paymentIntentId: intent.id,
      customerId: intent.customerId,
      orderId: intent.orderId,
      invoiceId: intent.invoiceId,
      method: ACCOUNTING_METHOD[intent.method ?? 'CARD'] ?? 'ONLINE_GATEWAY',
      status: (paid > 0 && paid < Number(intent.amount) - EPSILON
        ? 'PARTIALLY_PAID'
        : paid > 0
          ? 'PAID'
          : 'PENDING') as never,
      amount: paid,
      currency: intent.currency,
      provider: intent.provider,
      providerRef: intent.reference,
      paidAt: intent.paidAt,
    };
    if (existing) {
      await prismaUnscoped.payment.update({ where: { id: existing.id }, data });
    } else {
      await prismaUnscoped.payment.create({ data });
    }
  });

  // 2. Invoice: balance and status recomputed from what has actually been paid.
  if (intent.invoiceId) {
    await step('invoice', intentId, async () => {
      const invoice = await prismaUnscoped.invoice.findUnique({
        where: { id: intent.invoiceId! },
        select: { id: true, total: true, status: true, number: true, currency: true, dealId: true },
      });
      if (!invoice) return;
      const agg = await prismaUnscoped.paymentIntent.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { amountPaid: true },
      });
      const total = round2(Number(agg._sum.amountPaid ?? 0));
      const full = total >= Number(invoice.total) - EPSILON;
      // VOID is a decision a human made; a late payment does not undo it.
      if (invoice.status === 'VOID') return;
      await prismaUnscoped.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: total,
          status: full ? 'PAID' : total > EPSILON ? 'PARTIALLY_PAID' : invoice.status,
          ...(full ? { paidAt: new Date() } : {}),
        },
      });
    });
  }

  // 3. Order.
  if (intent.orderId) {
    await step('order', intentId, async () => {
      const order = await prismaUnscoped.order.findUnique({
        where: { id: intent.orderId! },
        select: { id: true, total: true, status: true },
      });
      if (!order) return;
      const agg = await prismaUnscoped.paymentIntent.aggregate({
        where: { orderId: order.id },
        _sum: { amountPaid: true },
      });
      const total = round2(Number(agg._sum.amountPaid ?? 0));
      const full = total >= Number(order.total) - EPSILON;
      await prismaUnscoped.order.update({
        where: { id: order.id },
        data: { paymentStatus: full ? 'PAID' : total > EPSILON ? 'PARTIALLY_PAID' : 'PENDING' },
      });

      // A business that wants eyes on every order before it is released keeps
      // the order where it is; the money is still recorded either way.
      if (full && settings.confirmationBehavior === 'AUTOMATIC' && order.status === 'PENDING') {
        await prismaUnscoped.order.update({
          where: { id: order.id },
          data: {
            status: 'CONFIRMED',
            statusHistory: {
              create: { toStatus: 'CONFIRMED', note: `Payment ${intent.reference} confirmed` },
            },
          },
        });
      }
    });
  }

  // 4. Property reservation / booking: only ever confirmed on full payment. A
  //    deposit that half-covers an inspection fee must not hold the slot.
  if (intent.resourceType === 'BOOKING' && intent.resourceId && opts.becamePaid) {
    await step('booking', intentId, async () => {
      await prismaUnscoped.propertyBooking.updateMany({
        where: { id: intent.resourceId!, status: 'REQUESTED' },
        data: { status: 'CONFIRMED' },
      });
    });
  }

  // 5. CRM timeline — visible on the customer and on the deal.
  await step('crm-timeline', intentId, async () => {
    const already = await prismaUnscoped.activity.findFirst({
      where: {
        organizationId: intent.organizationId,
        entityType: 'CUSTOMER',
        entityId: intent.customerId ?? intent.id,
        title: { contains: intent.reference },
      },
      select: { id: true },
    });
    if (already) return;
    await prismaUnscoped.activity.create({
      data: {
        organizationId: intent.organizationId,
        type: 'NOTE',
        entityType: 'CUSTOMER',
        entityId: intent.customerId ?? intent.id,
        title: `Payment received — ${intent.reference}`,
        body: `${intent.currency} ${paid.toFixed(2)}${intent.description ? ` for ${intent.description}` : ''}`,
        metadata: {
          paymentIntentId: intent.id,
          reference: intent.reference,
          method: intent.method,
          amount: paid,
          currency: intent.currency,
        },
      },
    });
  });

  // Everything below happens only on the transition into paid.
  if (!opts.becamePaid) return;

  // 6. Inventory. Reserved stock becomes shipped stock only when a business
  //    releases on payment; the order module owns the rules, so it is asked
  //    rather than second-guessed here.
  if (intent.orderId && settings.confirmationBehavior === 'AUTOMATIC') {
    await step('inventory', intentId, async () => {
      const { ordersService } = await import('../orders/orders.service');
      const svc = ordersService as unknown as {
        onPaymentConfirmed?: (orderId: string) => Promise<void>;
      };
      if (typeof svc.onPaymentConfirmed === 'function') {
        await svc.onPaymentConfirmed(intent.orderId!);
      }
    });
  }

  // 7. Deal rollup. Derived from invoices and intents rather than stored, so
  //    it cannot drift from the payments that justify it.
  if (intent.dealId || intent.invoiceId) {
    await step('deal', intentId, async () => {
      const dealId =
        intent.dealId ??
        (
          await prismaUnscoped.invoice.findUnique({
            where: { id: intent.invoiceId! },
            select: { dealId: true },
          })
        )?.dealId;
      if (!dealId) return;
      const { invoicesService } = await import('../invoices/invoices.service');
      await invoicesService.settleDealForInvoice(intent.invoiceId ?? '').catch(() => undefined);
    });
  }

  // 8. Receipt, if the business wants them.
  if (settings.autoReceipts) {
    await step('receipt', intentId, async () => {
      const { issueReceipt } = await import('./payment-receipt.service');
      await issueReceipt(intent.id);
    });
  }

  // 9. Confirmation, on the channels the business has switched on.
  await step('notify', intentId, async () => {
    const { notifyPaymentReceived } = await import('./payment-notify.service');
    await notifyPaymentReceived(intent.id);
  });
}
