import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { publicPayUrl } from './payment-intent.service';

/**
 * The receipt a customer keeps.
 *
 * Filed against their Vhicasar ID so it appears in the app's documents vault
 * alongside receipts from every other business, and reachable on the web from
 * the same token that took the payment.
 *
 * Idempotent on the intent: a retried webhook, a reconciliation sweep and a
 * manual re-check all produce one receipt, because a customer with three
 * receipts for one payment reasonably believes they were charged three times.
 */

export interface IssuedReceipt {
  receiptNumber: string;
  url: string;
  documentId: string | null;
}

/** Human-facing, derived from the reference so the two can be tied together. */
export function receiptNumberFor(reference: string): string {
  return reference.replace(/^VH-PI-/, 'VH-RC-');
}

export async function issueReceipt(intentId: string): Promise<IssuedReceipt | null> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent || !intent.token) return null;
  // Only a settled payment gets one. A receipt for a part payment would look
  // like proof the whole bill was cleared.
  if (intent.status !== 'PAID' && intent.status !== 'OVERPAID') return null;

  const receiptNumber = receiptNumberFor(intent.reference);
  const url = `${publicPayUrl(intent.token)}/receipt`;

  // The vault is keyed by Vhicasar ID, which only exists for customers who use
  // the app. A walk-in without one still gets the web receipt above.
  const link = intent.customerId
    ? await prismaUnscoped.customerLink.findFirst({
        where: { customerId: intent.customerId, organizationId: intent.organizationId },
        select: { vhicasarId: true },
      })
    : null;

  if (!link?.vhicasarId) return { receiptNumber, url, documentId: null };

  const existing = await prismaUnscoped.customerDocument.findFirst({
    where: {
      vhicasarId: link.vhicasarId,
      sourceType: 'PAYMENT_INTENT',
      sourceId: intent.id,
    },
    select: { id: true },
  });
  if (existing) return { receiptNumber, url, documentId: existing.id };

  const doc = await prismaUnscoped.customerDocument.create({
    data: {
      vhicasarId: link.vhicasarId,
      organizationId: intent.organizationId,
      kind: 'RECEIPT',
      title: `Receipt ${receiptNumber}`,
      sourceType: 'PAYMENT_INTENT',
      sourceId: intent.id,
      amount: intent.amountPaid,
      currency: intent.currency,
    },
  });
  return { receiptNumber, url, documentId: doc.id };
}
