import { randomUUID } from 'node:crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { invoicesService } from '../invoices/invoices.service';
import { createIntentForResource } from './payment-request.service';
import { publicPayUrl } from './payment-intent.service';
import { readPaymentSettings } from './payment-settings.service';

export interface AiOrderPaymentRequest {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  reference: string;
  payUrl: string;
  invoiceUrl: string;
  autoReceipts: boolean;
}

/**
 * The sole AI path for asking a customer to pay for an order. It guarantees
 * that the authoritative order invoice exists before the payment intent, and
 * reuses both records on retries.
 */
export async function createAiOrderPaymentRequest(input: {
  organizationId: string;
  customerId: string;
  orderId: string;
  enforceAiSetting?: boolean;
}): Promise<AiOrderPaymentRequest | null> {
  const settings = await readPaymentSettings(input.organizationId);
  if (input.enforceAiSetting !== false && !settings.aiCanCreatePaymentRequests) return null;

  let invoice = await prismaUnscoped.invoice.findFirst({
    where: {
      organizationId: input.organizationId,
      orderId: input.orderId,
      deletedAt: null,
      status: { not: 'VOID' },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true },
  });

  if (!invoice) {
    const created = await requestContext.run(
      { requestId: randomUUID(), organizationId: input.organizationId },
      () => invoicesService.createFromOrder(input.orderId),
    );
    invoice = { id: created.id, number: created.number };
  }

  const intent = await createIntentForResource({
    organizationId: input.organizationId,
    resourceType: 'INVOICE',
    resourceId: invoice.id,
    customerId: input.customerId,
    channel: 'AI',
    aiCreated: true,
  });
  const payUrl = publicPayUrl(intent.token!);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: Number(intent.amount),
    currency: intent.currency,
    reference: intent.reference,
    payUrl,
    invoiceUrl: `${payUrl}/invoice`,
    autoReceipts: settings.autoReceipts,
  };
}

export async function createAiInvoicePaymentRequest(input: {
  organizationId: string;
  customerId: string;
  invoiceId: string;
  enforceAiSetting?: boolean;
}): Promise<AiOrderPaymentRequest | null> {
  const settings = await readPaymentSettings(input.organizationId);
  if (input.enforceAiSetting !== false && !settings.aiCanCreatePaymentRequests) return null;
  const invoice = await prismaUnscoped.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!invoice) return null;
  const intent = await createIntentForResource({
    organizationId: input.organizationId,
    resourceType: 'INVOICE',
    resourceId: invoice.id,
    customerId: input.customerId,
    channel: 'AI',
    aiCreated: true,
  });
  const payUrl = publicPayUrl(intent.token!);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: Number(intent.amount),
    currency: intent.currency,
    reference: intent.reference,
    payUrl,
    invoiceUrl: `${payUrl}/invoice`,
    autoReceipts: settings.autoReceipts,
  };
}

export function formatAiPaymentRequest(request: AiOrderPaymentRequest): string {
  const receipt = request.autoReceipts
    ? `\nOnce your payment is confirmed, you'll receive a receipt.`
    : '';
  return (
    `\n\nYour invoice ${request.invoiceNumber} is ready for ${request.currency} ${request.amount.toLocaleString()}.\n` +
    `[View invoice](${request.invoiceUrl})\n` +
    `[Pay now](${request.payUrl})\n` +
    `Payment reference: ${request.reference}.${receipt}`
  );
}
