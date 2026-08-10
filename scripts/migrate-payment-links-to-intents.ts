/**
 * Fold PaymentLink into PaymentIntent.
 *
 * A link was only ever one way to *deliver* a payment request; keeping both
 * meant two lifecycles, two sets of rules about what "paid" means, and two
 * places to change when a business turns a method off. Every link becomes an
 * intent, and the intent takes over from there.
 *
 * The link's `token` is carried across unchanged, so every /pay/<token> URL
 * already in a customer's inbox, printed on an invoice or encoded in a QR code
 * keeps working against the new engine.
 *
 * Idempotent: re-running skips links that already have an intent, so it is
 * safe to run before and after a deploy. Nothing is deleted — the PaymentLink
 * rows stay as they are until the surfaces have been cut over and verified.
 *
 *   npx tsx scripts/migrate-payment-links-to-intents.ts [--dry-run]
 */
import { randomInt } from 'node:crypto';
import type { PaymentIntentResource, PaymentIntentStatus } from '@prisma/client';
import { prismaUnscoped as db } from '../src/infrastructure/database/prisma';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * A link's resource vocabulary is a subset of the intent's, except for the two
 * property kinds and the handful that were only ever free-text charges.
 */
const RESOURCE: Record<string, PaymentIntentResource> = {
  ORDER: 'ORDER',
  INVOICE: 'INVOICE',
  PROPERTY_PURCHASE: 'PROPERTY',
  PROPERTY_RESERVATION: 'PROPERTY_RESERVATION',
  BOOKING: 'BOOKING',
  QUOTATION: 'QUOTATION',
  SUBSCRIPTION: 'SUBSCRIPTION',
  DEPOSIT: 'DEPOSIT',
  POS: 'POS',
  RENT: 'RENT',
  MEMBERSHIP: 'CUSTOM',
  SERVICE: 'CUSTOM',
  CUSTOM: 'CUSTOM',
};

/**
 * PENDING becomes AWAITING_PAYMENT: the intent lifecycle distinguishes "raised
 * but untouched" from "gateway is working on it", which the link status never
 * did.
 */
const STATUS: Record<string, PaymentIntentStatus> = {
  PENDING: 'AWAITING_PAYMENT',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
};

const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function makeReference(): string {
  let out = '';
  for (let i = 0; i < 7; i += 1) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `VH-PI-${out}`;
}

async function main() {
  const links = await db.paymentLink.findMany({ orderBy: { createdAt: 'asc' } });
  console.log(`${links.length} payment link(s) found${DRY_RUN ? ' (dry run)' : ''}`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const link of links) {
    // The token is the identity that survives the move, so it is also what
    // tells us whether this link has already been migrated.
    const already = await db.paymentIntent.findUnique({ where: { token: link.token } });
    if (already) {
      skipped += 1;
      continue;
    }

    const resourceType = RESOURCE[link.resourceType] ?? 'CUSTOM';
    const status = STATUS[link.status] ?? 'AWAITING_PAYMENT';

    // Populate the typed relations where the link's scalar resourceId points
    // at something we can actually join to, so deal and invoice rollups see
    // migrated payments. Verified rather than assumed: a stale resourceId
    // would otherwise break the foreign key and fail the whole run.
    let orderId: string | null = null;
    let invoiceId: string | null = null;
    let propertyId: string | null = null;
    if (link.resourceId) {
      if (resourceType === 'ORDER') {
        orderId = (await db.order.findUnique({ where: { id: link.resourceId }, select: { id: true } }))?.id ?? null;
      } else if (resourceType === 'INVOICE') {
        invoiceId = (await db.invoice.findUnique({ where: { id: link.resourceId }, select: { id: true } }))?.id ?? null;
      } else if (resourceType === 'PROPERTY') {
        propertyId = (await db.property.findUnique({ where: { id: link.resourceId }, select: { id: true } }))?.id ?? null;
      }
    }

    // An invoice-linked payment belongs to the invoice's deal too, which is
    // what makes the deal rollup (§16) include money taken before this change.
    let dealId: string | null = null;
    if (invoiceId) {
      dealId = (await db.invoice.findUnique({ where: { id: invoiceId }, select: { dealId: true } }))?.dealId ?? null;
    }

    const customerId = link.customerId
      ? (await db.customer.findUnique({ where: { id: link.customerId }, select: { id: true } }))?.id ?? null
      : null;

    if (DRY_RUN) {
      created += 1;
      continue;
    }

    try {
      await db.paymentIntent.create({
        data: {
          organizationId: link.organizationId,
          reference: makeReference(),
          token: link.token,
          resourceType,
          resourceId: link.resourceId,
          customerId,
          orderId,
          invoiceId,
          dealId,
          propertyId,
          amount: link.amount,
          amountPaid: link.amountPaid,
          currency: link.currency,
          description: link.description,
          status,
          allowPartial: link.allowPartial,
          provider: link.provider,
          channel: 'LINK',
          createdById: link.createdById,
          expiresAt: link.expiresAt,
          paidAt: link.paidAt,
          createdAt: link.createdAt,
          // Keep the provenance: which link this came from, and anything the
          // link was carrying, so nothing is lost in the move.
          metadata: {
            ...((link.metadata as Record<string, unknown>) ?? {}),
            migratedFromPaymentLinkId: link.id,
            migratedProviderRef: link.providerRef,
          },
        },
      });
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`  ✗ link ${link.id}: ${(err as Error).message}`);
    }
  }

  console.log(`\ncreated ${created}, already migrated ${skipped}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
