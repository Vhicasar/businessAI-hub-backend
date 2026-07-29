import type { OrderStatus, Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { inventoryService } from '../inventory/inventory.service';
import { activityService } from '../crm/activity.service';
import { webhooksService } from '../api-keys/webhooks.service';
import { workflowService } from '../crm/workflow.service';
import { orderNotifyService } from '../notifications/order-notify.service';
import { exchangeRates } from '../../shared/exchange-rates';
import type { CreateOrderDto, ListOrdersDto, RecordPaymentDto, TransitionDto } from './orders.dto';

const round2 = (n: number): number => Math.round(n * 100) / 100;

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

/** Legal forward transitions. CANCELLED allowed from any pre-dispatch state. */
const TRANSITIONS: Record<string, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'PICKING', 'CANCELLED'],
  PROCESSING: ['PICKING', 'CANCELLED'],
  PICKING: ['PACKING', 'CANCELLED'],
  PACKING: ['READY_FOR_DISPATCH', 'CANCELLED'],
  READY_FOR_DISPATCH: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
};

const listSelect = {
  id: true,
  number: true,
  status: true,
  source: true,
  paymentStatus: true,
  currency: true,
  total: true,
  createdAt: true,
  customer: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { items: true } },
} as const;

const detailSelect = {
  ...listSelect,
  subtotal: true,
  taxTotal: true,
  shippingTotal: true,
  discountTotal: true,
  notes: true,
  cancelReason: true,
  deliveredAt: true,
  updatedAt: true,
  warehouse: { select: { id: true, name: true, code: true } },
  shippingAddress: {
    select: { id: true, addressLine1: true, city: true, state: true, country: true },
  },
  items: {
    select: {
      id: true,
      variantId: true,
      name: true,
      sku: true,
      quantity: true,
      unitPrice: true,
      taxRate: true,
      total: true,
    },
  },
  payments: {
    select: { id: true, amount: true, method: true, status: true, providerRef: true, paidAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' as const },
  },
  statusHistory: {
    select: { id: true, fromStatus: true, toStatus: true, note: true, createdAt: true },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

async function nextOrderNumber(tx: Pick<typeof prisma, 'order'>, organizationId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.order.count({
    where: { organizationId, number: { startsWith: `ORD-${year}-` } },
  });
  return `ORD-${year}-${String(count + 1).padStart(5, '0')}`;
}

async function orderForDisplay<T extends {
  currency: string;
  total: unknown;
  subtotal?: unknown;
  taxTotal?: unknown;
  shippingTotal?: unknown;
  discountTotal?: unknown;
  items?: Array<{ unitPrice: unknown; total: unknown }>;
  payments?: Array<{ amount: unknown }>;
}>(order: T): Promise<T> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { currency: true },
  });
  if (order.currency === org.currency) return order;
  const conversion = await exchangeRates.convert(1, order.currency, org.currency);
  const money = (value: unknown) => round2(Number(value) * conversion.rate);
  return {
    ...order,
    currency: org.currency,
    total: money(order.total),
    ...(order.subtotal !== undefined ? { subtotal: money(order.subtotal) } : {}),
    ...(order.taxTotal !== undefined ? { taxTotal: money(order.taxTotal) } : {}),
    ...(order.shippingTotal !== undefined ? { shippingTotal: money(order.shippingTotal) } : {}),
    ...(order.discountTotal !== undefined ? { discountTotal: money(order.discountTotal) } : {}),
    ...(order.items ? { items: order.items.map((i) => ({ ...i, unitPrice: money(i.unitPrice), total: money(i.total) })) } : {}),
    ...(order.payments ? { payments: order.payments.map((p) => ({ ...p, amount: money(p.amount) })) } : {}),
    sourceCurrency: order.currency,
    exchangeRate: conversion.rate,
    exchangeRateAsOf: conversion.asOf,
  } as T;
}

export const ordersService = {
  async list(dto: ListOrdersDto) {
    const rows = await prisma.order.findMany({
      where: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.customerId ? { customerId: dto.customerId } : {}),
        ...(dto.search ? { number: { contains: dto.search, mode: 'insensitive' as const } } : {}),
      },
      select: listSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = await Promise.all((hasMore ? rows.slice(0, dto.limit) : rows).map(orderForDisplay));
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async get(id: string) {
    const order = await prisma.order.findFirst({ where: { id }, select: detailSelect });
    if (!order) throw new NotFoundError('Order');
    return orderForDisplay(order);
  },

  /**
   * Creates the order with price snapshots, computed totals and stock
   * reservation at the chosen (or default) warehouse — all in one transaction.
   */
  async create(dto: CreateOrderDto, actorMembershipId: string | null) {
    const organizationId = orgId();
    const customer = await prisma.customer.findFirst({
      where: { id: dto.customerId, deletedAt: null },
    });
    if (!customer) throw new NotFoundError('Customer');
    if (customer.isBlocked) throw new ValidationError('This customer is blocked');

    const warehouse = dto.warehouseId
      ? await prisma.warehouse.findFirst({ where: { id: dto.warehouseId, deletedAt: null } })
      : await inventoryService.ensureDefaultWarehouse();
    if (!warehouse) throw new NotFoundError('Warehouse');

    const variantIds = dto.items.map((i) => i.variantId);
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, deletedAt: null, isActive: true },
      include: { product: { select: { name: true, taxRate: true, status: true } } },
    });
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    for (const item of dto.items) {
      const v = variantMap.get(item.variantId);
      if (!v) throw new NotFoundError(`Variant ${item.variantId}`);
      if (v.product.status !== 'ACTIVE') {
        throw new ValidationError(`"${v.product.name}" is not an active product`);
      }
    }
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });
    const convertedVariantPrices = new Map<string, number>();
    await Promise.all(variants.map(async (variant) => {
      const converted = await exchangeRates.convert(
        Number(variant.price),
        variant.currency,
        org.currency,
      );
      convertedVariantPrices.set(variant.id, converted.amount);
    }));

    const created = await prisma.$transaction(async (tx) => {
      // Reserve stock (row-by-row so error messages are precise).
      for (const item of dto.items) {
        const v = variantMap.get(item.variantId)!;
        const level = await tx.stockLevel.findUnique({
          where: {
            warehouseId_variantId: { warehouseId: warehouse.id, variantId: item.variantId },
          },
        });
        const available = level ? Number(level.quantity) - Number(level.reserved) : 0;
        if (available < item.quantity) {
          throw new ValidationError(
            `Insufficient stock for ${v.sku} at ${warehouse.name} (available ${available}, requested ${item.quantity})`
          );
        }
        await tx.stockLevel.update({
          where: { id: level!.id },
          data: { reserved: { increment: item.quantity } },
        });
      }

      // Totals with snapshots.
      let subtotal = 0;
      let taxTotal = 0;
      const itemRows = dto.items.map((item) => {
        const v = variantMap.get(item.variantId)!;
        // An explicit price is entered in the organization's preferred
        // currency; catalog prices are converted before totals are calculated.
        const unitPrice = round2(item.unitPrice ?? convertedVariantPrices.get(v.id)!);
        const lineNet = round2(unitPrice * item.quantity);
        const taxRate = Number(v.product.taxRate);
        const lineTax = round2((lineNet * taxRate) / 100);
        subtotal = round2(subtotal + lineNet);
        taxTotal = round2(taxTotal + lineTax);
        return {
          variantId: v.id,
          name: v.name ? `${v.product.name} — ${v.name}` : v.product.name,
          sku: v.sku,
          quantity: item.quantity,
          unitPrice,
          taxRate,
          discount: 0,
          total: round2(lineNet + lineTax),
        };
      });
      const total = round2(subtotal + taxTotal + dto.shippingTotal);

      const order = await tx.order.create({
        data: {
          organizationId,
          number: await nextOrderNumber(tx, organizationId),
          customerId: dto.customerId,
          status: 'PENDING',
          source: dto.source,
          warehouseId: warehouse.id,
          shippingAddressId: dto.shippingAddressId ?? null,
          currency: org.currency,
          subtotal,
          taxTotal,
          shippingTotal: dto.shippingTotal,
          discountTotal: 0,
          total,
          notes: dto.notes ?? null,
          placedById: actorMembershipId,
          items: { create: itemRows },
          statusHistory: { create: { toStatus: 'PENDING', note: 'Order created' } },
        },
        select: detailSelect,
      });
      return order;
    });
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'ORDER',
      entityId: created.id,
      title: `Order ${created.number} placed`,
      body: `${created.currency} ${Number(created.total).toFixed(2)} · ${dto.source}`,
      also: [{ entityType: 'CUSTOMER', entityId: dto.customerId }],
    });
    await workflowService.dispatch(
      'order.placed',
      { number: created.number, total: Number(created.total), source: dto.source, currency: created.currency },
      { entityType: 'ORDER', entityId: created.id, customerId: dto.customerId },
    );
    // Notify any subscribed external integrations (public API webhooks).
    void webhooksService.dispatch(organizationId, 'order.created', {
      id: created.id, number: created.number, status: created.status,
      total: Number(created.total), currency: created.currency, customerId: dto.customerId,
    });
    // Email the business's configured order-notification recipients.
    void orderNotifyService.notify(organizationId, 'order.received', {
      title: `Order ${created.number}`,
      lines: [
        `Total: ${created.currency} ${Number(created.total).toFixed(2)}`,
        `Source: ${dto.source}`,
      ],
    });
    return created;
  },

  async transition(id: string, dto: TransitionDto, actorUserId: string) {
    const order = await prisma.order.findFirst({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('Order');

    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new ConflictError(`Cannot move order from ${order.status} to ${dto.status}`, {
        allowed,
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Stock effects.
      if (dto.status === 'DISPATCHED' && order.warehouseId) {
        for (const item of order.items) {
          await tx.stockLevel.update({
            where: {
              warehouseId_variantId: {
                warehouseId: order.warehouseId,
                variantId: item.variantId,
              },
            },
            data: {
              quantity: { decrement: item.quantity },
              reserved: { decrement: item.quantity },
            },
          });
          await tx.stockMovement.create({
            data: {
              organizationId: order.organizationId,
              warehouseId: order.warehouseId,
              variantId: item.variantId,
              type: 'SALE',
              quantity: -Number(item.quantity),
              referenceType: 'ORDER',
              referenceId: order.id,
              actorUserId,
            },
          });
          await tx.orderItem.update({
            where: { id: item.id },
            data: { fulfilledQty: item.quantity },
          });
        }
      }
      if (dto.status === 'CANCELLED' && order.warehouseId) {
        // Release reservations (stock was only decremented at dispatch,
        // and DISPATCHED+ orders can't be cancelled per the transition map).
        for (const item of order.items) {
          await tx.stockLevel.update({
            where: {
              warehouseId_variantId: {
                warehouseId: order.warehouseId,
                variantId: item.variantId,
              },
            },
            data: { reserved: { decrement: item.quantity } },
          });
        }
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
          ...(dto.status === 'CANCELLED'
            ? { cancelledAt: new Date(), cancelReason: dto.note ?? null }
            : {}),
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus: dto.status,
              actorUserId,
              note: dto.note ?? null,
            },
          },
        },
        select: detailSelect,
      });
      return updated;
    });
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'ORDER',
      entityId: id,
      title: `Order ${order.number} → ${dto.status.toLowerCase().replace(/_/g, ' ')}`,
      body: dto.note ?? undefined,
      also: [{ entityType: 'CUSTOMER', entityId: order.customerId }],
    });
    return updated;
  },

  /**
   * Mark an order refunded and notify the business (spec #7). Status-level only —
   * moving the money happens in the payment gateway, out of this flow. Gated by
   * `orders.refund` at the route. A refund can be issued once payment has been
   * taken and the order isn't already refunded/cancelled.
   */
  async refund(id: string, dto: { reason?: string; amount?: number }, actorUserId: string) {
    const order = await prisma.order.findFirst({ where: { id } });
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'REFUNDED') throw new ConflictError('Order is already refunded');
    if (order.paymentStatus === 'PENDING') {
      throw new ConflictError('Nothing to refund — no payment has been recorded on this order');
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        paymentStatus: 'REFUNDED',
        statusHistory: {
          create: { fromStatus: order.status, toStatus: 'REFUNDED', actorUserId, note: dto.reason ?? null },
        },
      },
      select: detailSelect,
    });

    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'ORDER',
      entityId: id,
      title: `Refund issued for order ${order.number}`,
      body: dto.reason ?? undefined,
      also: [{ entityType: 'CUSTOMER', entityId: order.customerId }],
    });
    void orderNotifyService.notify(order.organizationId, 'refund.issued', {
      title: `Refund issued for order ${order.number}`,
      lines: [
        `Amount: ${order.currency} ${(dto.amount ?? Number(order.total)).toFixed(2)}`,
        ...(dto.reason ? [`Reason: ${dto.reason}`] : []),
      ],
    });
    await workflowService.dispatch(
      'order.refunded',
      { number: order.number, total: Number(order.total), currency: order.currency, reason: dto.reason ?? '' },
      { entityType: 'ORDER', entityId: id, customerId: order.customerId },
    );
    return updated;
  },

  async recordPayment(id: string, dto: RecordPaymentDto, actorMembershipId: string | null) {
    const order = await prisma.order.findFirst({
      where: { id },
      include: { payments: { where: { status: 'PAID' } } },
    });
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'CANCELLED') throw new ConflictError('Order is cancelled');

    const paidSoFar = order.payments.reduce((s, p) => s + Number(p.amount), 0);
    const remaining = round2(Number(order.total) - paidSoFar);
    if (dto.amount > remaining + 0.005) {
      throw new ValidationError(`Amount exceeds outstanding balance (${remaining.toFixed(2)})`);
    }

    const newPaid = round2(paidSoFar + dto.amount);
    const fullyPaid = newPaid >= Number(order.total) - 0.005;

    const paidResult = await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          organizationId: order.organizationId,
          customerId: order.customerId,
          orderId: order.id,
          method: dto.method,
          status: 'PAID',
          amount: dto.amount,
          currency: order.currency,
          provider: 'manual',
          providerRef: dto.reference ?? null,
          receivedById: actorMembershipId,
          paidAt: new Date(),
        },
      });

      const updated = await tx.order.update({
        where: { id },
        data: { paymentStatus: fullyPaid ? 'PAID' : 'PARTIALLY_PAID' },
        select: detailSelect,
      });

      // First full payment updates customer aggregates.
      if (fullyPaid) {
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            lifetimeValue: { increment: order.total },
            totalOrders: { increment: 1 },
            lastOrderAt: new Date(),
          },
        });
      }
      return updated;
    });
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'ORDER',
      entityId: id,
      title: `Payment recorded — ${order.currency} ${dto.amount.toFixed(2)}`,
      body: `${dto.method.replace(/_/g, ' ').toLowerCase()}${fullyPaid ? ' · fully paid' : ''}`,
      also: [{ entityType: 'CUSTOMER', entityId: order.customerId }],
    });
    if (fullyPaid) {
      await workflowService.dispatch(
        'order.paid',
        { number: order.number, total: Number(order.total), method: dto.method, currency: order.currency },
        { entityType: 'ORDER', entityId: id, customerId: order.customerId },
      );
    }
    // Email the business's configured recipients: always for the payment, plus
    // a confirmation once the order is fully settled.
    void orderNotifyService.notify(order.organizationId, 'payment.received', {
      title: `Payment on order ${order.number}`,
      lines: [
        `Amount: ${order.currency} ${dto.amount.toFixed(2)}`,
        `Method: ${dto.method.replace(/_/g, ' ').toLowerCase()}`,
        fullyPaid ? 'Order is now fully paid.' : 'Partial payment.',
      ],
    });
    if (fullyPaid) {
      void orderNotifyService.notify(order.organizationId, 'payment.confirmed', {
        title: `Order ${order.number} fully paid`,
        lines: [`Total: ${order.currency} ${Number(order.total).toFixed(2)}`],
      });
    }
    return paidResult;
  },
};
