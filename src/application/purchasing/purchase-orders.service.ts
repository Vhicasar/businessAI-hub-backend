import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PurchaseOrderStatus } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { emitEvent } from '../../shared/domain-events';
import { broadcast } from '../../infrastructure/realtime/live-events';
import { ZERO, money } from '../../shared/money';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

// ---------------------------------------------------------------- schemas

const lineSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  supplierSku: z.string().trim().max(80).nullable().optional(),
});

export const purchaseOrderSchema = z.object({
  supplierId: z.string().min(1),
  warehouseId: z.string().min(1),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  expectedAt: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  items: z.array(lineSchema).min(1, 'Add at least one item to order'),
});

export const updatePurchaseOrderSchema = purchaseOrderSchema.partial().extend({
  items: z.array(lineSchema).min(1).optional(),
});

export const listPurchaseOrdersSchema = z.object({
  status: z.enum(['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']).optional(),
  supplierId: z.string().optional(),
  warehouseId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  /** Only the ones raised by the reorder watcher — the buyer's review queue. */
  autoOnly: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const receiveSchema = z.object({
  /** Omit to receive everything still outstanding. */
  items: z
    .array(z.object({ itemId: z.string().min(1), quantity: z.coerce.number().positive() }))
    .optional(),
  note: z.string().trim().max(300).optional(),
});

export type PurchaseOrderDto = z.infer<typeof purchaseOrderSchema>;

/**
 * Legal forward transitions. A cancelled or fully-received order is final: the
 * stock has moved and the supplier has been told, so editing it after the fact
 * would put the books out of step with the warehouse.
 */
const TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

const EDITABLE: PurchaseOrderStatus[] = ['DRAFT'];

async function nextNumber(organizationId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prismaUnscoped.purchaseOrder.count({
    where: { organizationId, number: { startsWith: `PO-${year}-` } },
  });
  return `PO-${year}-${String(count + 1).padStart(5, '0')}`;
}

/**
 * Line and order totals, computed server-side so a client can't set them.
 * Generic so callers keep their own line fields (variant, supplier SKU) on the
 * way through rather than having to zip them back on afterwards.
 */
function totalsFor<T extends { quantity: number; unitCost: number; taxRate: number }>(items: T[]) {
  let subtotal = ZERO;
  let taxTotal = ZERO;
  const lines = items.map((i) => {
    const lineNet = money(i.quantity).mul(money(i.unitCost));
    const lineTax = lineNet.mul(money(i.taxRate)).div(100);
    subtotal = subtotal.add(lineNet);
    taxTotal = taxTotal.add(lineTax);
    return { ...i, total: money(lineNet.add(lineTax).toFixed(2)) };
  });
  return {
    lines,
    subtotal: money(subtotal.toFixed(2)),
    taxTotal: money(taxTotal.toFixed(2)),
    total: money(subtotal.add(taxTotal).toFixed(2)),
  };
}

const detailInclude = {
  supplier: { select: { id: true, name: true, code: true, email: true, phone: true, paymentTerms: true } },
  warehouse: { select: { id: true, name: true, code: true } },
  items: {
    include: {
      variant: {
        select: { id: true, sku: true, name: true, product: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

type PurchaseOrderWithRelations = Prisma.PurchaseOrderGetPayload<{ include: typeof detailInclude }>;

const view = (po: PurchaseOrderWithRelations) => ({
  id: po.id,
  number: po.number,
  status: po.status,
  currency: po.currency,
  subtotal: po.subtotal.toFixed(2),
  taxTotal: po.taxTotal.toFixed(2),
  total: po.total.toFixed(2),
  expectedAt: po.expectedAt,
  orderedAt: po.orderedAt,
  receivedAt: po.receivedAt,
  cancelledAt: po.cancelledAt,
  cancelReason: po.cancelReason,
  autoGenerated: po.autoGenerated,
  scanToken: po.scanToken,
  /**
   * What the QR on the printed order encodes. A custom scheme so the business
   * app can claim it, with the token alone as the payload — the scanner is
   * always an authenticated session, so nothing sensitive travels in the code.
   */
  scanPayload: po.scanToken ? `vhicasar://po/${po.scanToken}` : null,
  notes: po.notes,
  createdAt: po.createdAt,
  editable: EDITABLE.includes(po.status),
  supplier: po.supplier,
  warehouse: po.warehouse,
  items: po.items.map((i) => ({
    id: i.id,
    variantId: i.variantId,
    sku: i.variant.sku,
    name: i.variant.product.name + (i.variant.name && i.variant.name !== 'Default' ? ` — ${i.variant.name}` : ''),
    quantity: i.quantity.toString(),
    receivedQty: i.receivedQty.toString(),
    outstanding: money(i.quantity).sub(i.receivedQty).toString(),
    unitCost: i.unitCost.toFixed(2),
    taxRate: i.taxRate.toString(),
    total: i.total.toFixed(2),
    supplierSku: i.supplierSku,
  })),
});

export const purchaseOrdersService = {
  async list(q: z.infer<typeof listPurchaseOrdersSchema>) {
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
      ...(q.autoOnly ? { autoGenerated: true, status: 'DRAFT' as const } : {}),
      ...(q.search
        ? {
            OR: [
              { number: { contains: q.search, mode: 'insensitive' as const } },
              { supplier: { name: { contains: q.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const rows = await prisma.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: detailInclude,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return {
      items: items.map(view),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  async get(id: string) {
    const po = await prisma.purchaseOrder.findFirst({ where: { id }, include: detailInclude });
    if (!po) throw new NotFoundError('Purchase order');
    // Orders raised before scanning existed have no token; mint one on first
    // view so any order can be printed with a working QR.
    if (!po.scanToken) {
      const scanToken = newScanToken();
      await prisma.purchaseOrder.update({ where: { id }, data: { scanToken } });
      return view({ ...po, scanToken });
    }
    return view(po);
  },

  /**
   * Resolve a scanned QR to its order.
   *
   * Tenant-scoped through `prisma`, so a token from one business is simply not
   * found by another — scanning someone else's paperwork reveals nothing.
   */
  async byScanToken(token: string) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { scanToken: token },
      include: detailInclude,
    });
    if (!po) throw new NotFoundError('Purchase order');

    const outstanding = po.items.filter((i) => money(i.quantity).greaterThan(i.receivedQty));
    return {
      ...view(po),
      /** Whether scanning this can lead straight to a receipt. */
      receivable: po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED',
      // Say why not, so the scanner shows a reason rather than a dead end.
      blockedReason:
        po.status === 'DRAFT'
          ? 'This order has not been sent to the supplier yet.'
          : po.status === 'CANCELLED'
            ? 'This order was cancelled.'
            : po.status === 'RECEIVED'
              ? 'This order has already been received in full.'
              : null,
      outstandingLines: outstanding.length,
    };
  },

  async summary() {
    const organizationId = currentOrgId();
    const [byStatus, awaitingReview, outstanding] = await Promise.all([
      prismaUnscoped.purchaseOrder.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { _all: true },
      }),
      prismaUnscoped.purchaseOrder.count({
        where: { organizationId, autoGenerated: true, status: 'DRAFT' },
      }),
      prismaUnscoped.purchaseOrder.findMany({
        where: { organizationId, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } },
        select: { total: true, currency: true },
      }),
    ]);

    const committed = new Map<string, Prisma.Decimal>();
    for (const po of outstanding) {
      committed.set(po.currency, (committed.get(po.currency) ?? ZERO).add(money(po.total)));
    }

    const count = (s: PurchaseOrderStatus) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    return {
      draft: count('DRAFT'),
      ordered: count('ORDERED'),
      partiallyReceived: count('PARTIALLY_RECEIVED'),
      received: count('RECEIVED'),
      cancelled: count('CANCELLED'),
      awaitingReview,
      committedSpend: [...committed.entries()].map(([currency, total]) => ({
        currency,
        total: total.toFixed(2),
      })),
    };
  },

  async create(dto: PurchaseOrderDto, actorUserId?: string, opts: { autoGenerated?: boolean } = {}) {
    const organizationId = currentOrgId();
    const [supplier, warehouse] = await Promise.all([
      prisma.supplier.findFirst({ where: { id: dto.supplierId, deletedAt: null } }),
      prisma.warehouse.findFirst({ where: { id: dto.warehouseId, deletedAt: null } }),
    ]);
    if (!supplier) throw new NotFoundError('Supplier');
    if (!warehouse) throw new NotFoundError('Warehouse');
    if (!supplier.isActive) {
      throw new ConflictError(`${supplier.name} is archived. Restore it before ordering from it.`);
    }

    await assertVariantsExist(dto.items.map((i) => i.variantId));
    const { lines, subtotal, taxTotal, total } = totalsFor(dto.items);
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true },
    });
    const currency = dto.currency ?? supplier.currency ?? org?.currency ?? 'USD';

    const po = await prisma.purchaseOrder.create({
      data: {
        organizationId,
        number: await nextNumber(organizationId),
        supplierId: dto.supplierId,
        warehouseId: dto.warehouseId,
        currency,
        subtotal,
        taxTotal,
        total,
        expectedAt: dto.expectedAt ?? expectedFrom(supplier.leadTimeDays),
        notes: dto.notes ?? null,
        createdById: actorUserId ?? null,
        autoGenerated: opts.autoGenerated ?? false,
        scanToken: newScanToken(),
        items: {
          create: lines.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            taxRate: l.taxRate,
            total: l.total,
            supplierSku: l.supplierSku ?? null,
          })),
        },
      },
      include: detailInclude,
    });

    await auditService.record({
      action: 'purchase_order.created',
      entityType: 'PurchaseOrder',
      entityId: po.id,
      after: { number: po.number, supplier: supplier.name, total: po.total.toFixed(2), auto: po.autoGenerated },
    });
    await emitEvent({
      name: 'PurchaseOrderCreated',
      aggregateType: 'PurchaseOrder',
      aggregateId: po.id,
      payload: { number: po.number, supplierId: supplier.id, total: po.total.toFixed(2), autoGenerated: po.autoGenerated },
      organizationId,
    });
    return view(po);
  },

  /** Edit a draft. Items are replaced wholesale — the client sends the full list. */
  async update(id: string, dto: z.infer<typeof updatePurchaseOrderSchema>) {
    const existing = await prisma.purchaseOrder.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Purchase order');
    if (!EDITABLE.includes(existing.status)) {
      throw new ConflictError(
        `This order has already been ${existing.status.toLowerCase().replace(/_/g, ' ')} and can no longer be edited.`
      );
    }

    let totals: ReturnType<typeof totalsFor<z.infer<typeof lineSchema>>> | null = null;
    if (dto.items) {
      await assertVariantsExist(dto.items.map((i) => i.variantId));
      totals = totalsFor(dto.items);
    }

    const po = await prisma.$transaction(async (tx) => {
      if (totals) {
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
        await tx.purchaseOrderItem.createMany({
          data: totals.lines.map((l) => ({
            purchaseOrderId: id,
            variantId: l.variantId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            taxRate: l.taxRate,
            total: l.total,
            supplierSku: l.supplierSku ?? null,
          })),
        });
      }
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          ...(dto.supplierId ? { supplierId: dto.supplierId } : {}),
          ...(dto.warehouseId ? { warehouseId: dto.warehouseId } : {}),
          ...(dto.currency ? { currency: dto.currency } : {}),
          ...(dto.expectedAt === undefined ? {} : { expectedAt: dto.expectedAt }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
          ...(totals ? { subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total } : {}),
          // An edited auto-draft is now the buyer's own document.
          autoGenerated: false,
        },
        include: detailInclude,
      });
    });

    await auditService.record({
      action: 'purchase_order.updated',
      entityType: 'PurchaseOrder',
      entityId: id,
      after: { number: po.number, total: po.total.toFixed(2) },
    });
    return view(po);
  },

  /** Send it: the order is now committed to the supplier. */
  async place(id: string, actorUserId?: string) {
    const po = await this.transition(id, 'ORDERED', actorUserId);
    return po;
  },

  async cancel(id: string, reason: string | undefined, actorUserId?: string) {
    const existing = await prisma.purchaseOrder.findFirst({
      where: { id },
      include: { items: { select: { receivedQty: true } } },
    });
    if (!existing) throw new NotFoundError('Purchase order');
    // Partly-received stock is already in the warehouse; cancelling would leave
    // it on the shelf with no paperwork behind it.
    if (existing.items.some((i) => money(i.receivedQty).greaterThan(ZERO))) {
      throw new ConflictError(
        'Some of this order has already been received. Receive the rest or raise a return instead of cancelling.'
      );
    }
    return this.transition(id, 'CANCELLED', actorUserId, reason);
  },

  async transition(
    id: string,
    to: PurchaseOrderStatus,
    actorUserId?: string,
    reason?: string
  ) {
    const existing = await prisma.purchaseOrder.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Purchase order');
    if (!TRANSITIONS[existing.status].includes(to)) {
      throw new AppError(
        'INVALID_TRANSITION',
        409,
        `A ${existing.status.toLowerCase().replace(/_/g, ' ')} order cannot be marked ${to.toLowerCase().replace(/_/g, ' ')}.`
      );
    }

    const po = await prisma.purchaseOrder.update({
      where: { id },
      data: {
        status: to,
        ...(to === 'ORDERED' ? { orderedAt: new Date() } : {}),
        ...(to === 'RECEIVED' ? { receivedAt: new Date() } : {}),
        ...(to === 'CANCELLED' ? { cancelledAt: new Date(), cancelReason: reason ?? null } : {}),
      },
      include: detailInclude,
    });

    await auditService.record({
      action: `purchase_order.${to.toLowerCase()}`,
      entityType: 'PurchaseOrder',
      entityId: id,
      before: { status: existing.status },
      after: { status: to, ...(reason ? { reason } : {}) },
    });
    broadcast({
      event: 'purchase_order.status',
      payload: { id, number: po.number, status: to },
      organizationId: po.organizationId,
    });
    return view(po);
  },

  /**
   * Book a delivery in. Stock moves here and nowhere else in this flow, so a
   * receipt is the single point where the warehouse and the books agree.
   *
   * Partial deliveries are the norm, so quantities are per line and the order
   * only closes once every line is satisfied. Receiving more than was ordered
   * is refused rather than silently absorbed — it is almost always a typo, and
   * the alternative is stock appearing from nowhere.
   */
  async receive(id: string, dto: z.infer<typeof receiveSchema>, actorUserId?: string) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id },
      include: { items: true },
    });
    if (!po) throw new NotFoundError('Purchase order');
    if (po.status === 'DRAFT') {
      throw new ConflictError('Place this order with the supplier before receiving against it.');
    }
    if (po.status === 'CANCELLED') throw new ConflictError('This order was cancelled.');
    if (po.status === 'RECEIVED') throw new ConflictError('This order has already been received in full.');

    // No explicit lines means "everything still outstanding".
    const requested = dto.items
      ?? po.items
        .filter((i) => money(i.quantity).greaterThan(i.receivedQty))
        .map((i) => ({ itemId: i.id, quantity: Number(money(i.quantity).sub(i.receivedQty)) }));
    if (requested.length === 0) throw new ConflictError('Nothing is outstanding on this order.');

    for (const line of requested) {
      const item = po.items.find((i) => i.id === line.itemId);
      if (!item) throw new NotFoundError('Purchase order line');
      const outstanding = money(item.quantity).sub(item.receivedQty);
      if (money(line.quantity).greaterThan(outstanding)) {
        throw new ValidationError(
          `Cannot receive ${line.quantity} — only ${outstanding.toString()} of that line is outstanding.`
        );
      }
    }

    const organizationId = po.organizationId;
    const updated = await prisma.$transaction(async (tx) => {
      for (const line of requested) {
        const item = po.items.find((i) => i.id === line.itemId)!;
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { receivedQty: money(item.receivedQty).add(line.quantity) },
        });

        const level = await tx.stockLevel.upsert({
          where: { warehouseId_variantId: { warehouseId: po.warehouseId, variantId: item.variantId } },
          update: {},
          create: {
            organizationId,
            warehouseId: po.warehouseId,
            variantId: item.variantId,
            quantity: 0,
          },
        });
        await tx.stockLevel.update({
          where: { id: level.id },
          data: { quantity: money(level.quantity).add(line.quantity) },
        });
        await tx.stockMovement.create({
          data: {
            organizationId,
            warehouseId: po.warehouseId,
            variantId: item.variantId,
            type: 'PURCHASE_RECEIPT',
            quantity: money(line.quantity),
            referenceType: 'PURCHASE_ORDER',
            referenceId: po.id,
            reason: dto.note ?? `Received against ${po.number}`,
            actorUserId: actorUserId ?? null,
          },
        });
      }

      const fresh = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
      const complete = fresh.every((i) => money(i.receivedQty).greaterThanOrEqualTo(i.quantity));
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
          ...(complete ? { receivedAt: new Date() } : {}),
        },
        include: detailInclude,
      });
    });

    await auditService.record({
      action: 'purchase_order.received',
      entityType: 'PurchaseOrder',
      entityId: id,
      after: { number: po.number, status: updated.status, lines: requested.length },
    });
    await emitEvent({
      name: 'PurchaseOrderReceived',
      aggregateType: 'PurchaseOrder',
      aggregateId: id,
      payload: { number: po.number, status: updated.status },
      organizationId,
    });
    broadcast({
      event: 'purchase_order.status',
      payload: { id, number: updated.number, status: updated.status },
      organizationId,
    });
    return view(updated);
  },

  /** Only draft orders can be deleted; anything sent is a record of a commitment. */
  async remove(id: string) {
    const po = await prisma.purchaseOrder.findFirst({ where: { id } });
    if (!po) throw new NotFoundError('Purchase order');
    if (po.status !== 'DRAFT') {
      throw new ConflictError('Only draft orders can be deleted. Cancel this one instead.');
    }
    await prisma.purchaseOrder.delete({ where: { id } });
    await auditService.record({
      action: 'purchase_order.deleted',
      entityType: 'PurchaseOrder',
      entityId: id,
      before: { number: po.number },
    });
    return { id, deleted: true };
  },
};

/**
 * The secret behind a printed QR. 24 random bytes: long enough that guessing is
 * hopeless, short enough to scan reliably off a laser-printed page.
 */
function newScanToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Expected delivery from the supplier's own lead time, when they quote one. */
function expectedFrom(leadTimeDays: number | null): Date | null {
  if (leadTimeDays === null) return null;
  return new Date(Date.now() + leadTimeDays * 86_400_000);
}

async function assertVariantsExist(variantIds: string[]): Promise<void> {
  const unique = [...new Set(variantIds)];
  const found = await prisma.productVariant.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true },
  });
  if (found.length !== unique.length) {
    throw new NotFoundError('One of the products on this order');
  }
}
