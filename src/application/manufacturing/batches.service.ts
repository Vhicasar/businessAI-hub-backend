import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';

/**
 * Batches, and how to walk backwards from one.
 *
 * The reason this exists is a recall. When something is wrong with a case on a
 * shelf, the question is never "what is this batch" — it is "what else came
 * from the same sugar, and who sold it to us". So the trace runs the whole
 * way: batch → production order → what it consumed → the lots those came from
 * → the purchase orders and suppliers behind them.
 */

export const listBatchesSchema = z.object({
  variantId: z.string().optional(),
  warehouseId: z.string().optional(),
  qcStatus: z.enum(['PENDING', 'PASSED', 'FAILED', 'CONDITIONAL']).optional(),
  quarantinedOnly: z.coerce.boolean().optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const batchSelect = {
  id: true, batchNumber: true, productionDate: true, expiryDate: true,
  quantityProduced: true, quantityAvailable: true, qcStatus: true,
  isQuarantined: true, notes: true, createdAt: true,
  variant: {
    select: { id: true, sku: true, product: { select: { id: true, name: true, unit: true } } },
  },
  warehouse: { select: { id: true, name: true, code: true } },
  productionOrder: { select: { id: true, orderNumber: true, status: true } },
} as const;

export const batchesService = {
  async list(dto: z.infer<typeof listBatchesSchema>) {
    const cutoff = dto.expiringWithinDays
      ? new Date(Date.now() + dto.expiringWithinDays * 86_400_000)
      : null;

    const rows = await prisma.batch.findMany({
      where: {
        ...(dto.variantId ? { variantId: dto.variantId } : {}),
        ...(dto.warehouseId ? { warehouseId: dto.warehouseId } : {}),
        ...(dto.qcStatus ? { qcStatus: dto.qcStatus } : {}),
        ...(dto.quarantinedOnly ? { isQuarantined: true } : {}),
        ...(cutoff ? { expiryDate: { not: null, lte: cutoff } } : {}),
        ...(dto.search
          ? {
              OR: [
                { batchNumber: { contains: dto.search, mode: 'insensitive' as const } },
                { variant: { sku: { contains: dto.search, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      select: batchSelect,
      orderBy: [{ expiryDate: 'asc' }, { productionDate: 'desc' }],
      take: dto.limit,
    });

    const now = Date.now();
    return rows.map((b) => ({
      ...b,
      // Negative once past, so an overdue batch reads as overdue rather than
      // as "0 days".
      daysToExpiry: b.expiryDate
        ? Math.ceil((b.expiryDate.getTime() - now) / 86_400_000)
        : null,
      expired: b.expiryDate ? b.expiryDate.getTime() < now : false,
    }));
  },

  async get(id: string) {
    const batch = await prisma.batch.findFirst({ where: { id }, select: batchSelect });
    if (!batch) throw new NotFoundError('Batch');
    return batch;
  },

  async byNumber(batchNumber: string) {
    const batch = await prisma.batch.findFirst({ where: { batchNumber }, select: batchSelect });
    if (!batch) throw new NotFoundError('Batch');
    return batch;
  },

  /**
   * Everything behind one batch.
   *
   * Reads as the chain someone actually needs during a recall: this batch came
   * from this run, which used these lots of these materials, which arrived on
   * these purchase orders from these suppliers.
   */
  async trace(id: string) {
    const batch = await prisma.batch.findFirst({
      where: { id },
      select: {
        ...batchSelect,
        productionOrder: {
          select: {
            id: true, orderNumber: true, status: true,
            plannedQuantity: true, actualQuantity: true, rejectedQuantity: true,
            actualCompletionDate: true,
            bom: { select: { id: true, bomNumber: true, version: true } },
            productionLine: { select: { id: true, name: true, code: true } },
            consumption: {
              where: { consumedQuantity: { gt: 0 } },
              select: {
                id: true, consumedQuantity: true, issuedQuantity: true,
                batchNumber: true, occurredAt: true,
                variant: {
                  select: { id: true, sku: true, product: { select: { id: true, name: true, unit: true } } },
                },
                warehouse: { select: { id: true, name: true } },
              },
            },
          },
        },
        inspections: {
          select: {
            id: true, inspectionNumber: true, status: true, inspectedAt: true, comments: true,
          },
          orderBy: { inspectedAt: 'desc' },
        },
        quarantines: {
          select: {
            id: true, status: true, reason: true, quantity: true,
            heldAt: true, decidedAt: true, decisionReason: true,
          },
          orderBy: { heldAt: 'desc' },
        },
      },
    });
    if (!batch) throw new NotFoundError('Batch');

    /*
     * Where each consumed material came from.
     *
     * Read through the receipts rather than guessed: a receipt line knows the
     * batch that arrived and the purchase order it arrived on, and the order
     * knows the supplier. Without a recorded batch on the way in there is
     * nothing honest to say, so it reports the gap instead of inventing a link.
     */
    const materials = await Promise.all(
      (batch.productionOrder?.consumption ?? []).map(async (used) => {
        const sources = used.batchNumber
          ? await prisma.purchaseOrderReceiptLine.findMany({
              where: { batchNumber: used.batchNumber, item: { variantId: used.variant.id } },
              select: {
                batchNumber: true, expiryDate: true, quantity: true,
                receipt: {
                  select: {
                    createdAt: true,
                    purchaseOrder: {
                      select: {
                        id: true, number: true,
                        supplier: { select: { id: true, name: true } },
                      },
                    },
                  },
                },
              },
              take: 10,
            })
          : [];

        return {
          variantId: used.variant.id,
          sku: used.variant.sku,
          name: used.variant.product.name,
          unit: used.variant.product.unit,
          consumedQuantity: Number(used.consumedQuantity),
          issuedQuantity: Number(used.issuedQuantity),
          fromWarehouse: used.warehouse,
          lotNumber: used.batchNumber,
          /** Empty when the incoming lot was never recorded — said, not faked. */
          receivedFrom: sources.map((s) => ({
            purchaseOrderId: s.receipt.purchaseOrder?.id ?? null,
            purchaseOrderNumber: s.receipt.purchaseOrder?.number ?? null,
            supplier: s.receipt.purchaseOrder?.supplier ?? null,
            receivedAt: s.receipt.createdAt,
            quantity: Number(s.quantity),
            expiryDate: s.expiryDate,
          })),
          traceable: Boolean(used.batchNumber) && sources.length > 0,
        };
      }),
    );

    return {
      batch: {
        id: batch.id,
        batchNumber: batch.batchNumber,
        product: batch.variant.product,
        sku: batch.variant.sku,
        warehouse: batch.warehouse,
        productionDate: batch.productionDate,
        expiryDate: batch.expiryDate,
        quantityProduced: Number(batch.quantityProduced),
        quantityAvailable: Number(batch.quantityAvailable),
        qcStatus: batch.qcStatus,
        isQuarantined: batch.isQuarantined,
      },
      productionOrder: batch.productionOrder
        ? {
            id: batch.productionOrder.id,
            orderNumber: batch.productionOrder.orderNumber,
            status: batch.productionOrder.status,
            bom: batch.productionOrder.bom,
            productionLine: batch.productionOrder.productionLine,
            plannedQuantity: Number(batch.productionOrder.plannedQuantity),
            actualQuantity: Number(batch.productionOrder.actualQuantity),
            rejectedQuantity: Number(batch.productionOrder.rejectedQuantity),
            completedAt: batch.productionOrder.actualCompletionDate,
          }
        : null,
      materials,
      inspections: batch.inspections,
      quarantines: batch.quarantines,
      /**
       * Whether the chain is complete enough to act on. A recall against a
       * partially traceable batch is still possible, but the person running it
       * needs to know which links are missing before they rely on it.
       */
      fullyTraceable: materials.length > 0 && materials.every((m) => m.traceable),
      untraceableMaterials: materials.filter((m) => !m.traceable).map((m) => m.sku),
    };
  },

  /**
   * Forward from a material lot: everything made with it.
   *
   * The other half of a recall — a supplier says a delivery was bad, and the
   * question is what went out of the door containing it.
   */
  async affectedBy(lotNumber: string) {
    const uses = await prisma.materialConsumption.findMany({
      where: { batchNumber: lotNumber },
      select: {
        consumedQuantity: true,
        variant: { select: { sku: true, product: { select: { name: true } } } },
        productionOrder: {
          select: {
            id: true, orderNumber: true, status: true,
            batches: { select: batchSelect },
          },
        },
      },
    });

    const batches = uses.flatMap((u) => u.productionOrder?.batches ?? []);
    return {
      lotNumber,
      usedIn: uses.map((u) => ({
        sku: u.variant.sku,
        name: u.variant.product.name,
        consumedQuantity: Number(u.consumedQuantity),
        productionOrder: u.productionOrder
          ? { id: u.productionOrder.id, orderNumber: u.productionOrder.orderNumber, status: u.productionOrder.status }
          : null,
      })),
      /** The finished batches that would have to be recalled. */
      affectedBatches: batches,
      totalAffectedQuantity: batches.reduce((sum, b) => sum + Number(b.quantityAvailable), 0),
    };
  },
};
