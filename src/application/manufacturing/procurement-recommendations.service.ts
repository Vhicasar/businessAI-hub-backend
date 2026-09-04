import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { productionOrdersService } from './production-orders.service';
import { purchaseOrdersService } from '../purchasing/purchase-orders.service';
import { requisitionsService } from '../inventory/requisitions.service';

/**
 * What to do about a shortage (§8).
 *
 * Two different answers, and the difference matters: if the material exists
 * somewhere else in the business, the answer is to move it; if it does not
 * exist at all, the answer is to buy it. Recommending a purchase for stock
 * already sitting in the next warehouse wastes money, and requisitioning from
 * a branch that has none wastes a day.
 *
 * Nothing here spends money on its own. A recommendation is produced and shown;
 * acting on it is a separate, explicit call — §8 is emphatic that no purchase
 * order appears without a person agreeing to it.
 *
 * On terminology: this product has no separate "purchase requisition" entity.
 * Its equivalent is a DRAFT purchase order — the reorder policy calls it
 * "keeps a buyer in the loop" — so that is what gets created, reusing the
 * procurement system rather than duplicating it with a parallel document.
 */

export const actOnRecommendationSchema = z.object({
  /** Which materials to act on. Omitted, every recommended line is used. */
  variantIds: z.array(z.string().min(1)).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const requisitionFromShortageSchema = z.object({
  /** The store being asked to supply. */
  fromWarehouseId: z.string().min(1),
  variantIds: z.array(z.string().min(1)).optional(),
  reason: z.string().trim().max(1000).optional(),
  submit: z.boolean().optional(),
});

export const procurementRecommendationsService = {
  /**
   * Look at a production order's shortages and say what would fix each one.
   *
   * Read-only. Deliberately so: this is the screen a planner looks at while
   * deciding, and looking at options must never itself commit to one.
   */
  async forProductionOrder(productionOrderId: string) {
    const check = await productionOrdersService.materialCheck(productionOrderId);
    const short = check.items.filter((item) => item.shortfallQuantity > 0);

    /*
     * The store the run draws from, so it can be excluded below.
     *
     * Without this the "available elsewhere" list included the order's own
     * warehouse whenever it held *some* of a material it was short of, and
     * the requisition raised from it was refused outright — a warehouse
     * cannot requisition from itself.
     */
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: { warehouseId: true },
    });

    const recommendations = await Promise.all(
      short.map(async (item) => {
        const product = await prisma.productVariant.findUnique({
          where: { id: item.variantId },
          select: {
            id: true, sku: true,
            product: {
              select: {
                id: true, name: true, unit: true,
                safetyStock: true, minStock: true,
                suppliers: {
                  where: { isPreferred: true },
                  select: {
                    supplierId: true, supplierSku: true, costPrice: true,
                    leadTimeDays: true, minOrderQty: true,
                    supplier: { select: { id: true, name: true, leadTimeDays: true } },
                  },
                  take: 1,
                },
              },
            },
          },
        });

        // Elsewhere in the business — the cheaper answer when it exists.
        // Genuinely elsewhere: the run's own store is where the shortage is.
        const elsewhere = await prisma.stockLevel.findMany({
          where: {
            variantId: item.variantId,
            quantity: { gt: 0 },
            warehouse: { deletedAt: null, isActive: true },
            ...(order?.warehouseId ? { warehouseId: { not: order.warehouseId } } : {}),
          },
          select: {
            quantity: true, reserved: true,
            warehouse: { select: { id: true, name: true, code: true, warehouseType: true } },
          },
        });
        const transferable = elsewhere
          .map((l) => ({
            warehouse: l.warehouse,
            available: Number(l.quantity) - Number(l.reserved),
          }))
          .filter((l) => l.available > 0)
          .sort((a, b) => b.available - a.available);

        const preferred = product?.product.suppliers[0] ?? null;
        const safety = Number(product?.product.safetyStock ?? 0);
        const minOrder = Number(preferred?.minOrderQty ?? 0);

        /*
         * Buy the shortfall, plus enough to restore safety stock, and never
         * less than the supplier will sell. Buying exactly the shortfall
         * leaves the business at zero the moment the run finishes, which is
         * how the next order becomes an emergency.
         */
        const suggested = Math.max(item.shortfallQuantity + safety, minOrder, item.shortfallQuantity);

        return {
          variantId: item.variantId,
          sku: item.sku,
          name: item.name,
          unit: item.unit,
          requiredQuantity: item.requiredQuantity,
          availableQuantity: item.availableQuantity,
          shortfallQuantity: item.shortfallQuantity,
          incomingQuantity: item.incomingQuantity,
          safetyStock: safety,
          supplierMinimumOrder: minOrder || null,
          suggestedPurchaseQuantity: round3(suggested),
          preferredSupplier: preferred
            ? {
                id: preferred.supplier.id,
                name: preferred.supplier.name,
                supplierSku: preferred.supplierSku,
                unitCost: preferred.costPrice ? Number(preferred.costPrice) : null,
                leadTimeDays: preferred.leadTimeDays ?? preferred.supplier.leadTimeDays ?? null,
              }
            : null,
          /** Stores that could supply it without anything being bought. */
          availableElsewhere: transferable,
          /*
           * What a planner should do. `TRANSFER` wins when another store can
           * cover the whole shortfall — moving stock is faster and free.
           */
          recommendedAction:
            transferable.length > 0 && transferable[0]!.available >= item.shortfallQuantity
              ? ('TRANSFER' as const)
              : preferred
                ? ('PURCHASE' as const)
                : ('NO_SUPPLIER' as const),
        };
      }),
    );

    return {
      productionOrderId,
      orderNumber: check.orderNumber,
      product: check.product,
      canProceed: check.canProceed,
      shortageCount: short.length,
      /** Nothing has been created. Acting on this is a separate decision. */
      recommendations,
      unsourced: recommendations.filter((r) => r.recommendedAction === 'NO_SUPPLIER').map((r) => r.sku),
    };
  },

  /**
   * Create draft purchase orders from the recommendation — on request.
   *
   * Drafts, never sent orders. §8: the user reviews and submits. One order per
   * supplier, because that is what actually gets emailed to somebody.
   */
  async createDraftPurchaseOrders(
    productionOrderId: string,
    dto: z.infer<typeof actOnRecommendationSchema>,
  ) {
    const { recommendations, orderNumber } = await this.forProductionOrder(productionOrderId);
    const wanted = dto.variantIds
      ? recommendations.filter((r) => dto.variantIds!.includes(r.variantId))
      : recommendations;

    const buyable = wanted.filter((r) => r.preferredSupplier !== null);
    if (buyable.length === 0) {
      throw new ValidationError(
        wanted.length === 0
          ? 'There is nothing short on this production order.'
          : 'None of these materials has a preferred supplier, so there is nobody to order from. ' +
            'Set one on the product first.',
      );
    }

    // Grouped by supplier: a purchase order goes to one company.
    const bySupplier = new Map<string, typeof buyable>();
    for (const line of buyable) {
      const key = line.preferredSupplier!.id;
      bySupplier.set(key, [...(bySupplier.get(key) ?? []), line]);
    }

    const created = [];
    for (const [supplierId, lines] of bySupplier) {
      const po = await purchaseOrdersService.create({
        supplierId,
        warehouseId: await defaultWarehouseId(),
        notes:
          `Raised from production order ${orderNumber}. ` +
          `${dto.notes ?? 'Review the quantities and send when ready.'}`,
        items: lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.suggestedPurchaseQuantity,
          unitCost: line.preferredSupplier!.unitCost ?? 0,
          // Supplied explicitly: this calls the service rather than the route,
          // so the schema's defaults have not been applied.
          taxRate: 0,
          supplierSku: line.preferredSupplier!.supplierSku ?? null,
        })),
      } as never);

      created.push({
        purchaseOrderId: po.id,
        number: po.number,
        supplier: lines[0]!.preferredSupplier!.name,
        lines: lines.length,
      });
    }

    await auditService
      .record({
        action: 'production.procurement_recommended',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: {
          // Recorded as drafts so it is clear nothing was sent to a supplier.
          draftPurchaseOrders: created.map((c) => c.number),
          materials: buyable.map((b) => b.sku),
        },
        reason: dto.notes ?? null,
      })
      .catch(() => {});

    return {
      productionOrderId,
      /** Drafts. Nothing has been sent to a supplier. */
      draftPurchaseOrders: created,
      skipped: wanted.filter((r) => !r.preferredSupplier).map((r) => r.sku),
    };
  },

  /**
   * Ask another warehouse for what is short (§11).
   *
   * Uses the internal requisition the business already has, rather than a
   * manufacturing-specific transfer: the store being asked sees it in the same
   * queue as every other request, and approves and dispatches it the same way.
   */
  async requestFromWarehouse(
    productionOrderId: string,
    dto: z.infer<typeof requisitionFromShortageSchema>,
  ) {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: { id: true, orderNumber: true, warehouseId: true },
    });
    if (!order) throw new NotFoundError('Production order');
    if (!order.warehouseId) {
      throw new ValidationError(
        'This production order has no warehouse of its own, so there is nowhere for the materials to be sent.',
      );
    }
    if (order.warehouseId === dto.fromWarehouseId) {
      throw new ValidationError('A warehouse cannot requisition from itself.');
    }

    const { recommendations } = await this.forProductionOrder(productionOrderId);
    const wanted = dto.variantIds
      ? recommendations.filter((r) => dto.variantIds!.includes(r.variantId))
      : recommendations;
    if (wanted.length === 0) {
      throw new ValidationError('There is nothing short on this production order.');
    }

    const requisition = await requisitionsService.create({
      toWarehouseId: order.warehouseId,
      fromWarehouseId: dto.fromWarehouseId,
      priority: 'HIGH',
      reason: dto.reason ?? `Materials for production order ${order.orderNumber}`,
      submit: dto.submit ?? false,
      items: wanted.map((line) => ({
        variantId: line.variantId,
        requestedQty: line.shortfallQuantity,
      })),
    } as never);

    await auditService
      .record({
        action: 'production.materials_requisitioned',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: {
          requisition: (requisition as { number?: string }).number ?? null,
          materials: wanted.map((w) => w.sku),
        },
        reason: dto.reason ?? null,
      })
      .catch(() => {});
    return requisition;
  },
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

async function defaultWarehouseId(): Promise<string> {
  const wh =
    (await prisma.warehouse.findFirst({
      where: { deletedAt: null, isDefault: true },
      select: { id: true },
    })) ??
    (await prisma.warehouse.findFirst({ where: { deletedAt: null }, select: { id: true } }));
  if (!wh) throw new ValidationError('This business has no warehouse to receive a delivery into.');
  return wh.id;
}
