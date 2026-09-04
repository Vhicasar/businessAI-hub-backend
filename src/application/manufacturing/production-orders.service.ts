import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditDiff, auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { callerHasPermission } from '../roles/role-permissions';
import { bomService } from './bom.service';
import { availableIn } from './stock-ledger';
import type { ProductionOrderStatus } from '@prisma/client';

/**
 * Production orders — a committed decision to make something.
 *
 * The requirement is worked out from the BOM when the order is raised and then
 * frozen onto the order. A recipe edited next month must not silently rewrite
 * what a run in progress was supposed to use, and a completed run has to stay
 * explicable against the recipe it was actually made to.
 */

export const createProductionOrderSchema = z.object({
  productId: z.string().min(1),
  /** Omitted, the product's active BOM is used. */
  bomId: z.string().min(1).optional(),
  plannedQuantity: z.coerce.number().positive(),
  planId: z.string().min(1).optional(),
  productionLineId: z.string().min(1).nullable().optional(),
  /** Where materials are drawn from. */
  warehouseId: z.string().min(1).nullable().optional(),
  /** Where finished goods are booked in. */
  finishedWarehouseId: z.string().min(1).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  expectedCompletionDate: z.coerce.date().nullable().optional(),
  responsibleEmployeeId: z.string().min(1).nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const updateProductionOrderSchema = createProductionOrderSchema
  .omit({ productId: true, bomId: true, planId: true })
  .partial();

export const listProductionOrdersSchema = z.object({
  status: z.enum([
    'DRAFT', 'APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED',
  ]).optional(),
  productId: z.string().optional(),
  productionLineId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const orderSelect = {
  id: true, orderNumber: true, status: true, priority: true,
  plannedQuantity: true, actualQuantity: true, rejectedQuantity: true,
  startDate: true, expectedCompletionDate: true, actualCompletionDate: true,
  responsibleEmployeeId: true, notes: true, createdAt: true,
  product: { select: { id: true, name: true, unit: true } },
  bom: { select: { id: true, bomNumber: true, version: true } },
  productionLine: { select: { id: true, name: true, code: true, status: true } },
  // Scalars, not relations: ProductionOrder holds warehouse ids without a
  // declared relation, and a printed label is not worth a foreign-key
  // migration — the client already has the warehouse list to resolve them.
  warehouseId: true,
  finishedWarehouseId: true,
  // Printed onto the job card so the operator can scan it at the machine.
  scanToken: true,
} as const;

/**
 * What may follow what.
 *
 * Written out rather than left to each handler because the order of a
 * production run is the thing that makes its numbers mean anything: material
 * cannot be consumed by a run that has not started, and a completed run cannot
 * quietly go back to being a draft.
 */
const TRANSITIONS: Record<ProductionOrderStatus, ProductionOrderStatus[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['READY', 'IN_PROGRESS', 'CANCELLED'],
  READY: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** The permission each transition actually requires. */
const STATUS_PERMISSION: Partial<Record<ProductionOrderStatus, string>> = {
  APPROVED: 'production.approve',
  READY: 'production.approve',
  IN_PROGRESS: 'production.start',
  // Pausing a running line is part of running it.
  PAUSED: 'production.start',
  COMPLETED: 'production.complete',
  CANCELLED: 'production.cancel',
};

const TRANSITION_VERB: Record<ProductionOrderStatus, string> = {
  DRAFT: 'edit', APPROVED: 'approve', READY: 'approve', IN_PROGRESS: 'start',
  PAUSED: 'pause', COMPLETED: 'complete', CANCELLED: 'cancel',
};

export const productionOrdersService = {
  async list(dto: z.infer<typeof listProductionOrdersSchema>) {
    return prisma.productionOrder.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.productId ? { productId: dto.productId } : {}),
        ...(dto.productionLineId ? { productionLineId: dto.productionLineId } : {}),
        ...(dto.search
          ? {
              OR: [
                { orderNumber: { contains: dto.search, mode: 'insensitive' as const } },
                { product: { name: { contains: dto.search, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      select: orderSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit,
    });
  },

  async get(id: string) {
    const order = await prisma.productionOrder.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...orderSelect,
        warehouseId: true,
        finishedWarehouseId: true,
        materials: {
          select: {
            id: true, requiredQuantity: true, issuedQuantity: true,
            consumedQuantity: true, unit: true,
            variant: {
              select: {
                id: true, sku: true,
                product: { select: { id: true, name: true, unit: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundError('Production order');
    return order;
  },

  /**
   * Raise an order and freeze what it needs.
   *
   * The requirement is computed here, once, and stored. Recomputing it on
   * every read would mean a run's own history changed whenever the recipe did.
   */
  async create(dto: z.infer<typeof createProductionOrderSchema>) {
    const product = await prisma.product.findFirst({
      where: { id: dto.productId, deletedAt: null },
      select: { id: true, name: true, manufacturingEnabled: true },
    });
    if (!product) throw new NotFoundError('Product');

    const bom = dto.bomId
      ? await prisma.billOfMaterial.findFirst({
          where: { id: dto.bomId, deletedAt: null },
          select: { id: true, productId: true, status: true },
        })
      : await bomService.activeFor(dto.productId);

    if (!bom) {
      throw new ValidationError(
        `${product.name} has no active bill of materials, so there is no way to know what making it needs.`,
      );
    }
    if (bom.productId !== dto.productId) {
      throw new ValidationError('That bill of materials is for a different product.');
    }

    const requirements = await bomService.requirementsFor(bom.id, dto.plannedQuantity);
    const orderNumber = await nextOrderNumber();

    const order = await prisma.$transaction(async (tx) =>
      tx.productionOrder.create({
        data: {
          organizationId: currentOrgId(),
          orderNumber,
          planId: dto.planId ?? null,
          productId: dto.productId,
          bomId: bom.id,
          plannedQuantity: dto.plannedQuantity,
          productionLineId: dto.productionLineId ?? null,
          warehouseId: dto.warehouseId ?? null,
          finishedWarehouseId: dto.finishedWarehouseId ?? null,
          startDate: dto.startDate ?? null,
          expectedCompletionDate: dto.expectedCompletionDate ?? null,
          responsibleEmployeeId: dto.responsibleEmployeeId ?? null,
          priority: dto.priority,
          notes: dto.notes ?? null,
          materials: {
            create: requirements.items.map((item) => ({
              organizationId: currentOrgId(),
              variantId: item.variantId,
              requiredQuantity: item.requiredQuantity,
              unit: item.unit ?? null,
            })),
          },
        },
        select: orderSelect,
      }),
    );

    await auditService
      .record({
        action: 'production_order.created',
        entityType: 'PRODUCTION_ORDER',
        entityId: order.id,
        after: {
          orderNumber, product: product.name,
          plannedQuantity: dto.plannedQuantity,
          bom: requirements.bomNumber, bomVersion: requirements.version,
          materials: requirements.items.length,
        },
      })
      .catch(() => {});
    return order;
  },

  async update(id: string, dto: z.infer<typeof updateProductionOrderSchema>) {
    const before = await prisma.productionOrder.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, status: true, orderNumber: true,
        // Read so the audit entry can say what actually changed rather than
        // merely that something did.
        plannedQuantity: true, productionLineId: true, warehouseId: true,
        finishedWarehouseId: true, startDate: true, expectedCompletionDate: true,
        responsibleEmployeeId: true, priority: true, notes: true,
      },
    });
    if (!before) throw new NotFoundError('Production order');
    if (before.status === 'COMPLETED' || before.status === 'CANCELLED') {
      throw new ValidationError(`A ${before.status.toLowerCase()} production order cannot be changed.`);
    }

    const order = await prisma.productionOrder.update({
      where: { id },
      data: {
        ...(dto.plannedQuantity !== undefined ? { plannedQuantity: dto.plannedQuantity } : {}),
        ...(dto.productionLineId !== undefined ? { productionLineId: dto.productionLineId } : {}),
        ...(dto.warehouseId !== undefined ? { warehouseId: dto.warehouseId } : {}),
        ...(dto.finishedWarehouseId !== undefined ? { finishedWarehouseId: dto.finishedWarehouseId } : {}),
        ...(dto.startDate !== undefined ? { startDate: dto.startDate } : {}),
        ...(dto.expectedCompletionDate !== undefined ? { expectedCompletionDate: dto.expectedCompletionDate } : {}),
        ...(dto.responsibleEmployeeId !== undefined ? { responsibleEmployeeId: dto.responsibleEmployeeId } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      select: orderSelect,
    });
    const diff = auditDiff(before as never, order as never, [
      'plannedQuantity', 'productionLineId', 'warehouseId', 'finishedWarehouseId',
      'startDate', 'expectedCompletionDate', 'responsibleEmployeeId', 'priority', 'notes',
    ]);
    // A save that changed nothing is not worth an audit entry.
    if (diff) {
      await auditService
        .record({
          action: 'production_order.updated',
          entityType: 'PRODUCTION_ORDER',
          entityId: id,
          before: diff.before,
          after: { orderNumber: before.orderNumber, ...diff.after },
        })
        .catch(() => {});
    }
    return order;
  },

  /**
   * Can this run actually go ahead? (§7)
   *
   * Compares what the order froze against what is really on the shelf, and
   * says so per material. Deliberately reports rather than refuses: a shortage
   * is information a planner acts on — by buying, by requisitioning from
   * another store, or by running a smaller batch — not an error.
   */
  async materialCheck(id: string) {
    const order = await prisma.productionOrder.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, orderNumber: true, warehouseId: true, plannedQuantity: true,
        product: { select: { id: true, name: true } },
        materials: {
          select: {
            requiredQuantity: true, issuedQuantity: true, unit: true,
            variant: {
              select: {
                id: true, sku: true,
                product: { select: { id: true, name: true, unit: true, safetyStock: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundError('Production order');

    const lines = await Promise.all(
      order.materials.map(async (material) => {
        const variantId = material.variant.id;
        const required = Number(material.requiredQuantity);
        const alreadyIssued = Number(material.issuedQuantity);
        const outstanding = Math.max(0, required - alreadyIssued);

        // Stock in the order's own store when it has one; across the business
        // when it does not, since that is the honest answer to "do we have it".
        const stock = order.warehouseId
          ? await availableIn(prisma as never, order.warehouseId, variantId)
          : await totalAvailable(variantId);

        // What is already on its way in, from purchase orders not yet received.
        const incoming = await incomingQuantity(variantId);
        const shortfall = Math.max(0, outstanding - stock.available);
        const afterIncoming = stock.available + incoming;
        const safety = Number(material.variant.product.safetyStock ?? 0);

        return {
          variantId,
          sku: material.variant.sku,
          name: material.variant.product.name,
          unit: material.unit ?? material.variant.product.unit,
          requiredQuantity: round3(required),
          issuedQuantity: round3(alreadyIssued),
          outstandingQuantity: round3(outstanding),
          availableQuantity: round3(stock.available),
          reservedQuantity: round3(stock.reserved),
          incomingQuantity: round3(incoming),
          availableAfterIncoming: round3(afterIncoming),
          shortfallQuantity: round3(shortfall),
          status: statusFor({ outstanding, available: stock.available, incoming, safety }),
        };
      }),
    );

    const shortages = lines.filter((l) => l.shortfallQuantity > 0);
    return {
      productionOrderId: order.id,
      orderNumber: order.orderNumber,
      product: order.product,
      plannedQuantity: Number(order.plannedQuantity),
      /** True when every material is there — the only case that needs no thought. */
      canProceed: shortages.length === 0,
      shortageCount: shortages.length,
      items: lines,
    };
  },

  /** Move an order along, refusing anything the lifecycle does not allow. */
  async transition(id: string, to: ProductionOrderStatus, reason?: string) {
    /*
     * Approving, starting, completing and cancelling share one endpoint, and
     * the route guard is ANY-of — so without this check somebody trusted only
     * to cancel a run could approve and start one instead. The permission is
     * chosen by what is actually being asked for.
     */
    const needed = STATUS_PERMISSION[to];
    if (needed && !(await callerHasPermission(needed))) {
      throw new ForbiddenError(`You do not have permission to ${TRANSITION_VERB[to]} a production order`);
    }

    const order = await prisma.productionOrder.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, orderNumber: true },
    });
    if (!order) throw new NotFoundError('Production order');

    const allowed = TRANSITIONS[order.status];
    if (!allowed.includes(to)) {
      throw new ConflictError(
        allowed.length === 0
          ? `${order.orderNumber} is ${order.status.toLowerCase()} and cannot change.`
          : `A ${order.status.toLowerCase()} order can only become ${allowed
              .map((s) => s.toLowerCase())
              .join(' or ')}.`,
      );
    }

    const updated = await prisma.productionOrder.update({
      where: { id },
      data: {
        status: to,
        ...(to === 'IN_PROGRESS' && !order.status.startsWith('PAUSED')
          ? { startDate: new Date() }
          : {}),
        ...(to === 'COMPLETED' ? { actualCompletionDate: new Date() } : {}),
      },
      select: orderSelect,
    });

    await auditService
      .record({
        action: `production_order.${to.toLowerCase()}`,
        entityType: 'PRODUCTION_ORDER',
        entityId: id,
        before: { status: order.status },
        after: { status: to },
        reason: reason ?? null,
      })
      .catch(() => {});
    return updated;
  },
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * How worried to be about one material.
 *
 * `LOW_STOCK` exists so that "you have exactly enough, and nothing spare"
 * does not read the same as "you are comfortable" — running a business to
 * zero is how the next order becomes an emergency.
 */
function statusFor(input: {
  outstanding: number;
  available: number;
  incoming: number;
  safety: number;
}): 'AVAILABLE' | 'LOW_STOCK' | 'INCOMING' | 'SHORTAGE' | 'UNAVAILABLE' {
  if (input.outstanding <= 0) return 'AVAILABLE';
  if (input.available >= input.outstanding + input.safety) return 'AVAILABLE';
  if (input.available >= input.outstanding) return 'LOW_STOCK';
  if (input.available + input.incoming >= input.outstanding) return 'INCOMING';
  if (input.available > 0) return 'SHORTAGE';
  return 'UNAVAILABLE';
}

/** Usable stock of one material across every warehouse. */
async function totalAvailable(variantId: string) {
  const levels = await prisma.stockLevel.findMany({
    where: { variantId },
    select: { quantity: true, reserved: true },
  });
  const quantity = levels.reduce((sum, l) => sum + Number(l.quantity), 0);
  const reserved = levels.reduce((sum, l) => sum + Number(l.reserved), 0);
  return { quantity, reserved, available: quantity - reserved };
}

/**
 * What is already bought but not yet arrived.
 *
 * Read from the existing purchase orders rather than a manufacturing-specific
 * table: an order placed by the buying team is the same fact whether or not it
 * was placed for a production run.
 */
async function incomingQuantity(variantId: string): Promise<number> {
  const items = await prisma.purchaseOrderItem.findMany({
    where: {
      variantId,
      // Only orders actually outstanding: a draft is not incoming stock, and a
      // received or cancelled one is not either.
      purchaseOrder: { status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } },
    },
    select: { quantity: true, receivedQty: true },
  });
  return items.reduce(
    (sum, item) => sum + Math.max(0, Number(item.quantity) - Number(item.receivedQty)),
    0,
  );
}

async function nextOrderNumber(): Promise<string> {
  const count = await prisma.productionOrder.count();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `PROD-${String(count + 1 + attempt).padStart(5, '0')}`;
    const clash = await prisma.productionOrder.findFirst({
      where: { orderNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError('Could not allocate a production order number.');
}
