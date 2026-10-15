import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { normalizePhone } from '../sms/phone-numbers';
import {
  readFulfilmentSettings,
  resolveOrigin,
  formatAddress,
  type FulfilmentConfig,
} from '../delivery/fulfilment-settings.service';
import {
  quoteDelivery,
  pickupFee,
  quoteIsFresh,
  type DeliveryQuote,
} from '../delivery/delivery-pricing.service';
import { publicPaymentView, type PublicPaymentView } from './payment-public.service';

/**
 * The part of checkout that happens before any money moves.
 *
 * A payment link used to be one question — "pay this amount?" — which is fine
 * for a bill and wrong for an order, because an order has to go somewhere, and
 * where it goes changes what it costs. This service is where that is settled:
 * what the customer is buying, how they want it, where to, what the delivery
 * comes to, and who to contact about it.
 *
 * Everything here is authoritative. The browser sends a choice and an address;
 * the prices, the weights, the rates and the distance are read on this side.
 * The amount the gateway is eventually asked for is the amount this service
 * computed, not one that travelled through a form field.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Invoice statuses whose totals may still be changed. A paid bill is history. */
const MUTABLE_INVOICE_STATUSES = ['DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;

export interface CheckoutContact {
  name: string;
  phone: string;
  email: string;
}

export interface CheckoutOrderLine {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface CheckoutView extends PublicPaymentView {
  order: {
    id: string;
    number: string;
    items: CheckoutOrderLine[];
    subtotal: number;
    taxTotal: number;
    discountTotal: number;
    shippingTotal: number;
    total: number;
  } | null;
  invoiceNumber: string | null;
  fulfilment: {
    /** True when the customer must choose before they can pay. */
    required: boolean;
    chosen: 'PICKUP' | 'DELIVERY' | null;
    pickup: {
      available: boolean;
      locationName: string;
      address: string;
      instructions: string;
      fee: number;
      mapUrl: string | null;
    };
    delivery: {
      available: boolean;
      /** Whether a real road distance can be obtained, or only an estimate. */
      distanceIsApproximate: boolean;
      chargesForWeight: boolean;
      chargesForDistance: boolean;
    };
    /** The quote currently attached to the order, if any. */
    quote: DeliveryQuote | null;
    /** Whether that quote may still be charged. */
    quoteValid: boolean;
    contact: CheckoutContact | null;
    destination: Record<string, unknown> | null;
  };
}

interface CheckoutContext {
  intent: Prisma.PaymentIntentGetPayload<Record<string, never>>;
  order:
    | Prisma.OrderGetPayload<{ include: { items: true; invoices: true } }>
    | null;
  config: FulfilmentConfig;
}

/**
 * The order behind a payment, however the link was raised.
 *
 * An intent points at an order directly when one raised it, and at an invoice
 * when the invoice did — and that invoice usually came from an order. Both
 * routes lead to the same basket, and checkout needs the basket.
 */
async function loadContext(token: string): Promise<CheckoutContext> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { token } });
  if (!intent) throw new NotFoundError('Payment');

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
        include: { items: true, invoices: { where: { deletedAt: null, status: { not: 'VOID' } } } },
      })
    : null;

  return { intent, order, config: await readFulfilmentSettings(intent.organizationId) };
}

/**
 * Whether this checkout has to ask how the goods are being handed over.
 *
 * Only when there is an order to hand over and the business offers a choice.
 * A bill, a deposit or a subscription has nothing to collect or deliver, and
 * asking would be noise; a business that has configured neither pickup nor
 * delivery is answered the same way it always was.
 */
function fulfilmentRequired(ctx: CheckoutContext): boolean {
  if (!ctx.order) return false;
  if (ctx.order.fulfillmentMethod) return false;
  return ctx.config.pickup.enabled || ctx.config.delivery.enabled;
}

function mapUrlFor(config: FulfilmentConfig): string | null {
  const { coordinates, address } = config.pickup;
  if (coordinates.latitude !== null && coordinates.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${coordinates.latitude},${coordinates.longitude}`;
  }
  const line = formatAddress(address);
  return line ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(line)}` : null;
}

function readQuote(order: CheckoutContext['order']): DeliveryQuote | null {
  const raw = order?.deliveryQuote as unknown;
  return raw && typeof raw === 'object' ? (raw as DeliveryQuote) : null;
}

export async function checkoutView(token: string): Promise<CheckoutView> {
  const [base, ctx] = await Promise.all([publicPaymentView(token), loadContext(token)]);
  const { order, config } = ctx;
  const quote = readQuote(order);
  const origin = resolveOrigin(config);

  const invoiceNumber = order?.invoices?.[0]?.number ?? null;

  return {
    ...base,
    order: order
      ? {
          id: order.id,
          number: order.number,
          items: order.items.map((i) => ({
            name: i.name,
            sku: i.sku,
            quantity: Number(i.quantity),
            unitPrice: Number(i.unitPrice),
            total: Number(i.total),
          })),
          subtotal: Number(order.subtotal),
          taxTotal: Number(order.taxTotal),
          discountTotal: Number(order.discountTotal),
          shippingTotal: Number(order.shippingTotal),
          total: Number(order.total),
        }
      : null,
    invoiceNumber,
    fulfilment: {
      required: fulfilmentRequired(ctx),
      chosen: order?.fulfillmentMethod ?? null,
      pickup: {
        available: Boolean(order) && config.pickup.enabled,
        locationName: config.pickup.locationName || origin.name,
        address: formatAddress(config.pickup.address) || formatAddress(config.businessAddress),
        instructions: config.pickup.instructions,
        fee: round2(config.pickup.fee),
        mapUrl: mapUrlFor(config),
      },
      delivery: {
        available: Boolean(order) && config.delivery.enabled,
        // Said out loud rather than implied: a straight-line estimate is not a
        // route, and a customer told "12.4 km" deserves to know which it is.
        distanceIsApproximate: !(await import('../delivery/geo.service')).mapsConfigured(),
        chargesForWeight: config.delivery.pricing.perKg > 0,
        chargesForDistance: config.delivery.pricing.perKm > 0,
      },
      quote,
      quoteValid: quote ? quoteIsFresh(quote) : false,
      contact:
        order && (order.contactName || order.contactPhone || order.contactEmail)
          ? {
              name: order.contactName ?? '',
              phone: order.contactPhone ?? '',
              email: order.contactEmail ?? '',
            }
          : null,
      destination: (order?.deliverySnapshot as Record<string, unknown> | null) ?? null,
    },
  };
}

export interface ChooseFulfilmentInput {
  method: 'PICKUP' | 'DELIVERY';
  contact: { name: string; phone: string; email?: string };
  destination?: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    country: string;
    postalCode?: string;
    instructions?: string;
    latitude?: number | null;
    longitude?: number | null;
  };
}

/**
 * Record how the order is being fulfilled and what that costs.
 *
 * Returns the whole checkout again rather than just the fee, because the fee
 * is never the only thing that moved: the order total, the invoice and the
 * amount the gateway will be asked for all change with it, and a customer
 * shown a delivery fee while the "amount due" above it still reads the old
 * total has been told two different things at once.
 */
export async function chooseFulfilment(token: string, input: ChooseFulfilmentInput): Promise<CheckoutView> {
  const ctx = await loadContext(token);
  const { intent, order, config } = ctx;

  if (!order) throw new ValidationError('There is no order on this payment to fulfil');
  if (intent.status === 'PAID' || intent.status === 'OVERPAID') {
    throw new ConflictError('This payment has already been settled');
  }
  if (intent.status === 'CANCELLED' || intent.status === 'EXPIRED') {
    throw new ConflictError('This payment request is no longer open');
  }

  const name = input.contact.name?.trim() ?? '';
  const phone = input.contact.phone?.trim() ?? '';
  if (!name) throw new ValidationError('Enter the name of the person receiving this order');
  if (!phone) throw new ValidationError('Enter a phone number we can reach you on');
  const email = input.contact.email?.trim().toLowerCase() || null;

  if (input.method === 'PICKUP' && !config.pickup.enabled) {
    throw new ValidationError('This business does not offer collection');
  }
  if (input.method === 'DELIVERY' && !config.delivery.enabled) {
    throw new ValidationError('This business does not offer delivery');
  }

  let quote: DeliveryQuote | null = null;
  let fee = 0;
  let snapshot: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
  let shippingAddressId: string | null = null;

  if (input.method === 'DELIVERY') {
    if (!input.destination) throw new ValidationError('Enter the delivery address');
    const address = {
      line1: input.destination.line1?.trim() ?? '',
      line2: input.destination.line2?.trim() ?? '',
      city: input.destination.city?.trim() ?? '',
      state: input.destination.state?.trim() ?? '',
      country: (input.destination.country ?? '').trim().toUpperCase(),
      postalCode: input.destination.postalCode?.trim() ?? '',
    };

    quote = await quoteDelivery({
      organizationId: intent.organizationId,
      items: order.items.map((i) => ({ variantId: i.variantId, quantity: Number(i.quantity) })),
      destination: {
        address,
        latitude: input.destination.latitude ?? null,
        longitude: input.destination.longitude ?? null,
      },
      subtotal: Number(order.subtotal),
      config,
    });

    // An unpriceable destination is not an error — the customer did nothing
    // wrong — so it comes back as a view carrying the reason, and the order is
    // left exactly as it was rather than half-changed.
    if (!quote.priced) {
      const view = await checkoutView(token);
      return { ...view, fulfilment: { ...view.fulfilment, quote, quoteValid: false } };
    }

    fee = quote.fee.total;
    snapshot = {
      ...address,
      instructions: input.destination.instructions?.trim() ?? '',
      formatted: quote.destination.formatted,
      latitude: quote.destination.latitude,
      longitude: quote.destination.longitude,
      recordedAt: new Date().toISOString(),
    };
    shippingAddressId = await upsertDeliveryAddress(order.customerId, {
      ...address,
      latitude: quote.destination.latitude,
      longitude: quote.destination.longitude,
    });
  } else {
    fee = pickupFee(config).total;
  }

  const totals = recomputeOrderTotals(order, fee);

  await prismaUnscoped.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        fulfillmentMethod: input.method,
        requiresDelivery: input.method === 'DELIVERY',
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        // Choosing collection clears the delivery it replaces. Leaving the old
        // address and fee behind is how an order is charged for a delivery
        // that nobody is going to make.
        deliverySnapshot: snapshot,
        deliveryQuote: quote ? (quote as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        shippingAddressId: input.method === 'DELIVERY' ? shippingAddressId : null,
        shippingTotal: totals.shippingTotal,
        total: totals.total,
        notes:
          input.method === 'DELIVERY' && input.destination?.instructions?.trim()
            ? input.destination.instructions.trim()
            : order.notes,
      },
    });

    await syncInvoiceForOrder(tx, order.id, {
      method: input.method,
      fee,
      quote,
      currency: order.currency,
    });

    await syncIntentAmount(tx, intent.id, order.id);
  });

  return checkoutView(token);
}

/** Order money, with the new fulfilment fee in place of the old one. */
function recomputeOrderTotals(
  order: { subtotal: unknown; taxTotal: unknown; discountTotal: unknown },
  fee: number,
): { shippingTotal: number; total: number } {
  const subtotal = new Prisma.Decimal(order.subtotal as Prisma.Decimal);
  const tax = new Prisma.Decimal(order.taxTotal as Prisma.Decimal);
  const discount = new Prisma.Decimal(order.discountTotal as Prisma.Decimal);
  const shipping = new Prisma.Decimal(fee);
  const total = subtotal.add(tax).add(shipping).sub(discount);
  return {
    shippingTotal: round2(shipping.toNumber()),
    total: round2(Math.max(0, total.toNumber())),
  };
}

/**
 * Reuse the customer's address when it is the same one, add it when it is not.
 *
 * Never edits an address row in place. Address-book rows are shared by every
 * order that points at them, so editing one to match this order would silently
 * rewrite where a previous order went.
 */
async function upsertDeliveryAddress(
  customerId: string,
  address: {
    line1: string; line2: string; city: string; state: string; country: string;
    postalCode: string; latitude: number | null; longitude: number | null;
  },
): Promise<string> {
  const existing = await prismaUnscoped.customerAddress.findFirst({
    where: {
      customerId,
      addressLine1: address.line1,
      city: address.city,
      country: address.country || 'NG',
      ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    },
    select: { id: true, latitude: true, longitude: true },
  });
  if (existing) {
    // Filling in coordinates we did not have before is an addition, not a
    // rewrite: the address itself is unchanged.
    if (existing.latitude === null && address.latitude !== null) {
      await prismaUnscoped.customerAddress.update({
        where: { id: existing.id },
        data: { latitude: address.latitude, longitude: address.longitude },
      });
    }
    return existing.id;
  }
  const created = await prismaUnscoped.customerAddress.create({
    data: {
      customerId,
      label: 'Delivery',
      addressLine1: address.line1,
      addressLine2: address.line2 || null,
      city: address.city,
      state: address.state || null,
      country: (address.country || 'NG').slice(0, 2).toUpperCase(),
      postalCode: address.postalCode || null,
      latitude: address.latitude,
      longitude: address.longitude,
    },
    select: { id: true },
  });
  return created.id;
}

/** The label a fulfilment fee appears under on the invoice. */
const FEE_LABELS = { PICKUP: 'Collection', DELIVERY: 'Delivery' } as const;

/**
 * Put the fee on the invoice, as a line and in the totals.
 *
 * The old `createFromOrder` copied the order's total onto the invoice while
 * building line items from the order's items alone, so an order with shipping
 * produced an invoice whose lines did not add up to its own total. With a real
 * delivery fee that stops being cosmetic, so the fee gets a line of its own.
 */
async function syncInvoiceForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  fulfilment: { method: 'PICKUP' | 'DELIVERY'; fee: number; quote: DeliveryQuote | null; currency: string },
): Promise<void> {
  const invoices = await tx.invoice.findMany({
    where: { orderId, deletedAt: null, status: { in: [...MUTABLE_INVOICE_STATUSES] } },
    include: { items: true },
  });
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { subtotal: true, taxTotal: true, discountTotal: true, shippingTotal: true, total: true },
  });

  for (const invoice of invoices) {
    const label = FEE_LABELS[fulfilment.method];
    const existingFeeLines = invoice.items.filter(
      (i) => i.description === FEE_LABELS.DELIVERY || i.description === FEE_LABELS.PICKUP,
    );
    await tx.invoiceItem.deleteMany({ where: { id: { in: existingFeeLines.map((i) => i.id) } } });

    if (fulfilment.fee > 0) {
      await tx.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          description: label,
          quantity: 1,
          unitPrice: fulfilment.fee,
          taxRate: 0,
          total: fulfilment.fee,
        },
      });
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        discountTotal: order.discountTotal,
        total: order.total,
      },
    });
  }
}

/**
 * Keep the amount the customer will be charged equal to what they are buying.
 *
 * Also abandons any gateway session opened for the previous figure. A session
 * initialised for the old total must not be the one that settles, or the
 * customer pays one amount and the invoice records another.
 */
async function syncIntentAmount(
  tx: Prisma.TransactionClient,
  intentId: string,
  orderId: string,
): Promise<void> {
  const [intent, order] = await Promise.all([
    tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } }),
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
  ]);
  const next = new Prisma.Decimal(order.total);
  if (next.equals(new Prisma.Decimal(intent.amount))) return;

  const metadata = ((intent.metadata as Record<string, unknown>) ?? {});
  delete metadata.gateway;
  await tx.paymentIntent.update({
    where: { id: intentId },
    data: {
      amount: next,
      status: intent.status === 'PROCESSING' ? 'AWAITING_PAYMENT' : intent.status,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
  logger.info({ intentId, amount: next.toFixed(2) }, 'checkout: payable amount updated');
}

/**
 * Whether checkout may proceed to payment.
 *
 * The question the initiate route asks before it opens a gateway session, so
 * that an order which still needs a delivery quote cannot be paid for at the
 * pre-delivery price.
 */
export async function blockingCheckoutIssue(token: string): Promise<string | null> {
  const ctx = await loadContext(token);
  if (!ctx.order) return null;
  if (fulfilmentRequired(ctx)) return 'Choose collection or delivery before paying.';
  if (ctx.order.fulfillmentMethod === 'DELIVERY') {
    const quote = readQuote(ctx.order);
    if (!quote) return 'Enter a delivery address before paying.';
    if (!quoteIsFresh(quote)) return 'The delivery price has expired. Please confirm your address again.';
  }
  return null;
}

/**
 * The contact details given at checkout, normalised for matching.
 *
 * Exported because settlement needs exactly this when it decides which
 * customer profile the payment belongs to.
 */
export function normalisedContact(order: {
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}): { name: string | null; phone: string | null; email: string | null } {
  return {
    name: order.contactName?.trim() || null,
    phone: order.contactPhone
      ? normalizePhone(order.contactPhone).e164 ?? order.contactPhone.trim()
      : null,
    email: order.contactEmail?.trim().toLowerCase() || null,
  };
}
