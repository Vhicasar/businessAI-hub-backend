import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { NotFoundError, ValidationError } from '../../shared/errors';
import {
  buildReceiptForIntent,
  renderReceiptHtml,
  type ReceiptData,
} from './receipt-document.service';
import { receiptEmailState } from './receipt-email.service';

/**
 * The business's view of a receipt — the same document the customer gets.
 *
 * Built from the payment that settled the order rather than from the order
 * alone, because a receipt is a record of money moving, and the reference, the
 * method and the provider's own id all live on the payment.
 */
export async function orderReceipt(orderId: string): Promise<
  ReceiptData & {
    html: string;
    email: Awaited<ReturnType<typeof receiptEmailState>>;
  }
> {
  const organizationId = requestContext.get()?.organizationId;
  if (!organizationId) throw new Error('No tenant in request context');

  const order = await prismaUnscoped.order.findFirst({
    where: { id: orderId, organizationId },
    select: { id: true, paymentStatus: true },
  });
  if (!order) throw new NotFoundError('Order');

  // Newest first: a part payment followed by the balance should produce the
  // receipt for the payment that settled it.
  const intent = await prismaUnscoped.paymentIntent.findFirst({
    where: {
      organizationId,
      OR: [{ orderId }, { invoice: { orderId } }],
      status: { in: ['PAID', 'OVERPAID', 'PARTIALLY_PAID'] },
    },
    orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  if (!intent) {
    throw new ValidationError(
      'There is no confirmed payment on this order yet, so there is no receipt to show.',
    );
  }

  const receipt = await buildReceiptForIntent(intent.id);
  return {
    ...receipt,
    html: await renderReceiptHtml(receipt),
    email: await receiptEmailState(intent.id),
  };
}

/** Retry the receipt email for an order's settled payment. */
export async function resendOrderReceipt(orderId: string) {
  const organizationId = requestContext.get()?.organizationId;
  if (!organizationId) throw new Error('No tenant in request context');

  const intent = await prismaUnscoped.paymentIntent.findFirst({
    where: {
      organizationId,
      OR: [{ orderId }, { invoice: { orderId } }],
      status: { in: ['PAID', 'OVERPAID'] },
    },
    orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  if (!intent) {
    throw new ValidationError('There is no confirmed payment on this order to send a receipt for.');
  }
  const { sendReceiptEmail } = await import('./receipt-email.service');
  return sendReceiptEmail(intent.id, { force: true });
}
