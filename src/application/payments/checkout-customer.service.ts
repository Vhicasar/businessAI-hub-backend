import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { normalizePhone } from '../sms/phone-numbers';

/**
 * Carrying checkout details back to the customer's profile — carefully.
 *
 * The details a customer types at checkout are the best information anyone has
 * about how to reach them, and until now they went to the payment gateway and
 * nowhere else. They belong on the profile.
 *
 * But only where they fill a gap. A profile that already has an email address
 * keeps it: the person paying is not always the person the profile belongs to
 * — a husband pays for his wife's order, an assistant for their employer's —
 * and overwriting a known address with whoever happened to be at the keyboard
 * loses the business a customer's real contact details. The same reasoning
 * rules out touching the name at all: a recipient name is a delivery
 * instruction, not an identity claim.
 *
 * The order's own snapshot is written during checkout and is independent of
 * everything here. If this fails, the business still sees who to contact.
 */

export interface ProfileSyncResult {
  customerId: string | null;
  /** Fields that were empty and have been filled from checkout. */
  filled: string[];
  /** Fields left alone because the profile already had a different value. */
  kept: string[];
  error: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function syncCustomerFromCheckout(intentId: string): Promise<ProfileSyncResult> {
  const empty: ProfileSyncResult = { customerId: null, filled: [], kept: [], error: null };
  try {
    const intent = await prismaUnscoped.paymentIntent.findUnique({
      where: { id: intentId },
      select: { id: true, organizationId: true, orderId: true, invoiceId: true, customerId: true, metadata: true },
    });
    if (!intent) return { ...empty, error: 'Payment not found' };

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
          select: { id: true, customerId: true, contactEmail: true, contactPhone: true },
        })
      : null;

    const customerId = order?.customerId ?? intent.customerId ?? null;
    if (!customerId) return empty;

    // Make sure the payment and the order agree about whose it is, so a
    // receipt raised from an invoice still reaches the right vault.
    if (!intent.customerId) {
      await prismaUnscoped.paymentIntent.update({
        where: { id: intent.id },
        data: { customerId },
      });
    }

    const metadata = (intent.metadata as Record<string, unknown>) ?? {};
    const email =
      (order?.contactEmail ?? (metadata.checkoutEmail as string | undefined) ?? '').trim().toLowerCase() || null;
    const phoneRaw = order?.contactPhone?.trim() || null;
    const phone = phoneRaw ? normalizePhone(phoneRaw).e164 ?? phoneRaw : null;

    const customer = await prismaUnscoped.customer.findUnique({
      where: { id: customerId },
      select: { id: true, email: true, phone: true, organizationId: true },
    });
    if (!customer) return { ...empty, customerId, error: 'Customer not found' };
    // Belt and braces against a mis-linked order: never write across tenants.
    if (customer.organizationId !== intent.organizationId) {
      return { ...empty, customerId, error: 'Customer belongs to another business' };
    }

    const data: Record<string, string> = {};
    const filled: string[] = [];
    const kept: string[] = [];

    if (email && EMAIL.test(email)) {
      if (!customer.email) {
        data.email = email;
        filled.push('email');
      } else if (customer.email.trim().toLowerCase() !== email) {
        kept.push('email');
      }
    }
    if (phone) {
      if (!customer.phone) {
        data.phone = phone;
        filled.push('phone');
      } else if ((normalizePhone(customer.phone).e164 ?? customer.phone) !== phone) {
        kept.push('phone');
      }
    }

    if (Object.keys(data).length > 0) {
      await prismaUnscoped.customer.update({ where: { id: customerId }, data });
    }
    return { customerId, filled, kept, error: null };
  } catch (err) {
    // A profile that could not be updated must never cost the business a paid
    // order. Report it and move on; the order keeps its own snapshot.
    logger.warn({ err: (err as Error).message, intentId }, 'checkout profile sync failed');
    return { ...empty, error: (err as Error).message };
  }
}
