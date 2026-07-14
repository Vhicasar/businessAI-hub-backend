import type { OrderStatus, Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { inventoryService } from '../inventory/inventory.service';
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

async function nextOrderNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.order.count({
    where: { organizationId, number: { startsWith: `ORD-${year}-` } },
  });
  return `ORD-${year}-${String(count + 1).padStart(5, '0')}`;
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
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async get(id: string) {
    const order = await prisma.order.findFirst({ where: { id }, select: detailSelect });
    if (!order) throw new NotFoundError('Order');
    return order;
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

    return prisma.$transaction(async (tx) => {
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
        const unitPrice = round2(item.unitPrice ?? Number(v.price));
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
          currency: variants[0]?.currency ?? 'USD',
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

    return prisma.$transaction(async (tx) => {
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

    return prisma.$transaction(async (tx) => {
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
  },
};
