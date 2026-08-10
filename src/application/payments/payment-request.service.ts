import type { PaymentIntentResource } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, NotFoundError } from '../../shared/errors';
import { paymentIntentService } from './payment-intent.service';
import { readPaymentSettings } from './payment-settings.service';

/**
 * Raising a payment request against something the business is owed.
 *
 * The one place that decides *how much* to ask for. Every surface — the web
 * app, chat, the AI, the API — comes through here, so none of them can name
 * its own price: the figure is read from the record being paid, minus whatever
 * has already been collected against it.
 *
 * The exceptions are the two resource kinds that have no underlying record to
 * read — a free-text charge and a deposit — where the amount necessarily comes
 * from the person raising it, and where the permission to do so is the control.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const CALLER_PRICED: PaymentIntentResource[] = ['CUSTOM', 'DEPOSIT', 'POS', 'INSPECTION_FEE'];

export interface CreateRequestInput {
  organizationId: string;
  resourceType: PaymentIntentResource;
  resourceId?: string;
  customerId?: string;
  amount?: number;
  currency?: string;
  description?: string;
  allowPartial?: boolean;
  expiryMinutes?: number;
  channel?: string;
  createdById?: string | null;
  aiCreated?: boolean;
}

/** What is still owed on a record, and everything needed to describe it. */
async function resolveFromResource(input: CreateRequestInput): Promise<{
  amount: number;
  currency: string;
  description: string;
  customerId: string | null;
  orderId: string | null;
  invoiceId: string | null;
  dealId: string | null;
  propertyId: string | null;
}> {
  const { resourceType, resourceId, organizationId } = input;

  if (resourceType === 'INVOICE') {
    if (!resourceId) throw new AppError('MISSING_RESOURCE', 400, 'An invoice id is required.');
    const invoice = await prismaUnscoped.invoice.findFirst({
      where: { id: resourceId, organizationId },
      select: {
        id: true, number: true, total: true, amountPaid: true, currency: true,
        customerId: true, orderId: true, dealId: true, status: true,
      },
    });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === 'VOID') {
      throw new AppError('INVOICE_VOID', 409, 'This invoice was voided and cannot be paid.');
    }
    const outstanding = round2(Number(invoice.total) - Number(invoice.amountPaid));
    if (outstanding <= 0.005) {
      throw new AppError('NOTHING_OUTSTANDING', 409, `Invoice ${invoice.number} is already paid.`);
    }
    return {
      amount: outstanding,
      currency: invoice.currency,
      description: `Invoice ${invoice.number}`,
      customerId: invoice.customerId,
      orderId: invoice.orderId,
      invoiceId: invoice.id,
      dealId: invoice.dealId,
      propertyId: null,
    };
  }

  if (resourceType === 'ORDER') {
    if (!resourceId) throw new AppError('MISSING_RESOURCE', 400, 'An order id is required.');
    const order = await prismaUnscoped.order.findFirst({
      where: { id: resourceId, organizationId },
      select: { id: true, number: true, total: true, currency: true, customerId: true, status: true },
    });
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'CANCELLED') {
      throw new AppError('ORDER_CANCELLED', 409, 'This order was cancelled and cannot be paid.');
    }
    // Money already taken through any earlier intent for this order.
    const agg = await prismaUnscoped.paymentIntent.aggregate({
      where: { orderId: order.id },
      _sum: { amountPaid: true },
    });
    const outstanding = round2(Number(order.total) - Number(agg._sum.amountPaid ?? 0));
    if (outstanding <= 0.005) {
      throw new AppError('NOTHING_OUTSTANDING', 409, `Order ${order.number} is already paid.`);
    }
    return {
      amount: outstanding,
      currency: order.currency,
      description: `Order ${order.number}`,
      customerId: order.customerId,
      orderId: order.id,
      invoiceId: null,
      dealId: null,
      propertyId: null,
    };
  }

  if (resourceType === 'DEAL') {
    if (!resourceId) throw new AppError('MISSING_RESOURCE', 400, 'A deal id is required.');
    const deal = await prismaUnscoped.deal.findFirst({
      where: { id: resourceId, organizationId },
      select: { id: true, title: true, value: true, currency: true, customerId: true },
    });
    if (!deal) throw new NotFoundError('Deal');
    const agg = await prismaUnscoped.paymentIntent.aggregate({
      where: { dealId: deal.id },
      _sum: { amountPaid: true },
    });
    const outstanding = round2(Number(deal.value) - Number(agg._sum.amountPaid ?? 0));
    if (outstanding <= 0.005) {
      throw new AppError('NOTHING_OUTSTANDING', 409, `${deal.title} is fully paid.`);
    }
    return {
      amount: outstanding,
      currency: deal.currency,
      description: deal.title,
      customerId: deal.customerId,
      orderId: null,
      invoiceId: null,
      dealId: deal.id,
      propertyId: null,
    };
  }

  if (resourceType === 'PROPERTY' || resourceType === 'PROPERTY_RESERVATION' || resourceType === 'RENT') {
    if (!resourceId) throw new AppError('MISSING_RESOURCE', 400, 'A property id is required.');
    const property = await prismaUnscoped.property.findFirst({
      where: { id: resourceId, organizationId },
      select: { id: true, title: true, price: true, rentAmount: true, currency: true },
    });
    if (!property) throw new NotFoundError('Property');
    // Rent uses the rent figure; a purchase or reservation uses the price.
    // A caller-supplied amount is honoured here because reservation deposits
    // and instalments are genuinely a fraction of the headline figure.
    const listed =
      resourceType === 'RENT' ? Number(property.rentAmount ?? 0) : Number(property.price ?? 0);
    const amount = input.amount != null ? round2(input.amount) : round2(listed);
    if (!(amount > 0)) {
      throw new AppError(
        'NO_PRICE',
        409,
        `${property.title} has no ${resourceType === 'RENT' ? 'rent' : 'price'} set, so an amount must be given.`
      );
    }
    return {
      amount,
      currency: property.currency,
      description:
        resourceType === 'RENT'
          ? `Rent — ${property.title}`
          : resourceType === 'PROPERTY_RESERVATION'
            ? `Reservation — ${property.title}`
            : property.title,
      customerId: input.customerId ?? null,
      orderId: null,
      invoiceId: null,
      dealId: null,
      propertyId: property.id,
    };
  }

  // Free-text charges: the caller sets the amount, and holding
  // `payments.request` is what authorises that.
  if (CALLER_PRICED.includes(resourceType)) {
    if (input.amount == null) {
      throw new AppError('MISSING_AMOUNT', 400, 'An amount is required for this payment.');
    }
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true },
    });
    return {
      amount: round2(input.amount),
      currency: (input.currency ?? org?.currency ?? 'NGN').toUpperCase(),
      description: input.description ?? 'Payment',
      customerId: input.customerId ?? null,
      orderId: null,
      invoiceId: null,
      dealId: null,
      propertyId: null,
    };
  }

  // Anything else (booking, subscription, quotation, commission, instalment)
  // needs an explicit amount until it has a record of its own to read.
  if (input.amount == null) {
    throw new AppError('MISSING_AMOUNT', 400, 'An amount is required for this payment.');
  }
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true },
  });
  return {
    amount: round2(input.amount),
    currency: (input.currency ?? org?.currency ?? 'NGN').toUpperCase(),
    description: input.description ?? 'Payment',
    customerId: input.customerId ?? null,
    orderId: null,
    invoiceId: null,
    dealId: null,
    propertyId: null,
  };
}

export async function createIntentForResource(input: CreateRequestInput) {
  const resolved = await resolveFromResource(input);
  const settings = await readPaymentSettings(input.organizationId);

  if (!settings.paymentLinksEnabled && input.channel === 'LINK') {
    throw new AppError('PAYMENT_LINKS_DISABLED', 409, 'This business has payment links turned off.');
  }

  return paymentIntentService.create({
    organizationId: input.organizationId,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    customerId: input.customerId ?? resolved.customerId,
    orderId: resolved.orderId,
    invoiceId: resolved.invoiceId,
    dealId: resolved.dealId,
    propertyId: resolved.propertyId,
    amount: resolved.amount,
    currency: resolved.currency,
    description: input.description ?? resolved.description,
    allowPartial: input.allowPartial ?? false,
    channel: input.channel ?? null,
    createdById: input.createdById ?? null,
    aiCreated: input.aiCreated ?? false,
    expiryMinutes: input.expiryMinutes ?? null,
  });
}
