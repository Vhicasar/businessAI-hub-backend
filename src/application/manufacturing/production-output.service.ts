import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { applyMovement } from './stock-ledger';
import { manufacturingSettings } from './settings.service';

/**
 * What came off the line, and the batch it became.
 *
 * Good output is what reaches the finished-goods store; rejects are recorded
 * but never booked in as sellable stock. The distinction is the whole point of
 * recording production separately from receiving it — a run that made 9,800
 * cases and threw 200 away did not produce 9,800 sellable cases, and a system
 * that adds the larger number is telling the sales team something untrue.
 *
 * Where the business requires quality sign-off, the batch arrives PENDING and
 * its stock is reserved rather than free (§14/§15): stock nobody has inspected
 * must not become sellable simply because nobody has got to it yet.
 */

export const recordOutputSchema = z.object({
  /** Defaults to the order's own product variant. */
  variantId: z.string().min(1).optional(),
  producedQuantity: z.coerce.number().positive(),
  rejectedQuantity: z.coerce.number().min(0).default(0),
  /** Defaults to the order's finished-goods warehouse. */
  warehouseId: z.string().min(1).optional(),
  /** Supply one, or let it be generated from the business's format. */
  batchNumber: z.string().trim().max(80).nullable().optional(),
  productionDate: z.coerce.date().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
  responsibleEmployeeId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** A retry must not book the same output twice. */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export const productionOutputService = {
  async record(
    productionOrderId: string,
    dto: z.infer<typeof recordOutputSchema>,
    actorUserId: string,
  ) {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: {
        id: true, organizationId: true, orderNumber: true, status: true,
        plannedQuantity: true, actualQuantity: true, rejectedQuantity: true,
        finishedWarehouseId: true, warehouseId: true,
        product: {
          select: {
            id: true, name: true, batchTracked: true, expiryTracked: true,
            variants: { where: { deletedAt: null }, select: { id: true, sku: true }, take: 2 },
          },
        },
      },
    });
    if (!order) throw new NotFoundError('Production order');
    if (!['IN_PROGRESS', 'PAUSED'].includes(order.status)) {
      throw new ValidationError(
        `Output cannot be recorded against a ${order.status.toLowerCase()} production order.`,
      );
    }

    if (dto.idempotencyKey) {
      const seen = await prisma.productionOutput.findFirst({
        where: { productionOrderId, notes: { contains: dto.idempotencyKey } },
        select: { id: true },
      });
      if (seen) return { alreadyRecorded: true, outputId: seen.id };
    }

    const variantId = dto.variantId ?? order.product.variants[0]?.id;
    if (!variantId) {
      throw new ValidationError(`${order.product.name} has no variant to book output against.`);
    }
    const warehouseId = dto.warehouseId ?? order.finishedWarehouseId ?? order.warehouseId;
    if (!warehouseId) {
      throw new ValidationError(
        'This production order has no finished-goods warehouse, so there is nowhere to book the output.',
      );
    }

    const good = dto.producedQuantity - dto.rejectedQuantity;
    if (good < 0) {
      throw new ValidationError('More was rejected than was produced.');
    }

    const settings = await manufacturingSettings.get();
    const needsQc = settings.requireQcBeforeRelease;
    const sku = order.product.variants.find((v) => v.id === variantId)?.sku ?? 'BATCH';
    const productionDate = dto.productionDate ?? new Date();

    const result = await prisma.$transaction(async (tx) => {
      // ── The batch ──────────────────────────────────────────────────────
      let batchId: string | null = null;
      let batchNumber: string | null = null;
      if (order.product.batchTracked || dto.batchNumber) {
        batchNumber =
          dto.batchNumber ??
          (await generateBatchNumber(tx, settings.batchNumberFormat, sku, productionDate));
        const batch = await tx.batch.create({
          data: {
            organizationId: order.organizationId,
            batchNumber,
            variantId,
            productionOrderId,
            productionDate,
            expiryDate: order.product.expiryTracked ? dto.expiryDate ?? null : null,
            quantityProduced: good,
            quantityAvailable: good,
            warehouseId,
            qcStatus: 'PENDING',
          },
          select: { id: true, batchNumber: true },
        });
        batchId = batch.id;
      }

      // ── Stock in ───────────────────────────────────────────────────────
      // Only the good quantity. Rejects are recorded on the output row and on
      // the order, and deliberately never become stock.
      if (good > 0) {
        await applyMovement(tx, {
          organizationId: order.organizationId,
          warehouseId,
          variantId,
          quantityChange: good,
          type: 'PRODUCTION',
          referenceType: 'PRODUCTION_ORDER',
          referenceId: productionOrderId,
          reason: dto.notes ?? null,
          batchNumber,
          expiryDate: dto.expiryDate ?? null,
          actorUserId,
        });

        /*
         * Held back until quality has looked at it.
         *
         * Reserved rather than absent: the stock physically exists and the
         * count must say so, but nothing may sell or transfer it. Releasing it
         * after a pass is what makes it ordinary available stock.
         */
        if (needsQc) {
          await tx.stockLevel.update({
            where: { warehouseId_variantId: { warehouseId, variantId } },
            data: { reserved: { increment: good } },
          });
          await tx.stockMovement.create({
            data: {
              organizationId: order.organizationId,
              warehouseId,
              variantId,
              type: 'QC_QUARANTINE',
              quantity: 0,
              referenceType: 'PRODUCTION_ORDER',
              referenceId: productionOrderId,
              reason: 'Awaiting quality inspection',
              batchNumber,
              actorUserId,
            },
          });
          /*
           * Recorded as a hold, not just a reserve.
           *
           * Stock awaiting inspection is quarantined in everything but name,
           * and writing it down as such gives one place that knows how much of
           * a batch is held. Without it, a later failure reserves the same
           * cases a second time and the warehouse appears to be holding twice
           * what it has.
           */
          if (batchId) {
            await tx.quarantineRecord.create({
              data: {
                organizationId: order.organizationId,
                batchId,
                quantity: good,
                reason: 'Awaiting quality inspection',
                status: 'HELD',
                heldByUserId: actorUserId,
              },
            });
          }
        }
      }

      const output = await tx.productionOutput.create({
        data: {
          organizationId: order.organizationId,
          productionOrderId,
          variantId,
          plannedQuantity: order.plannedQuantity,
          producedQuantity: dto.producedQuantity,
          rejectedQuantity: dto.rejectedQuantity,
          goodQuantity: good,
          warehouseId,
          batchId,
          productionDate,
          expiryDate: dto.expiryDate ?? null,
          responsibleEmployeeId: dto.responsibleEmployeeId ?? null,
          recordedByUserId: actorUserId,
          notes: [dto.notes, dto.idempotencyKey].filter(Boolean).join(' · ') || null,
        },
        select: { id: true, goodQuantity: true, producedQuantity: true, rejectedQuantity: true },
      });

      // Running totals on the order, so several partial outputs add up.
      await tx.productionOrder.update({
        where: { id: productionOrderId },
        data: {
          actualQuantity: { increment: good },
          rejectedQuantity: { increment: dto.rejectedQuantity },
        },
      });

      return { output, batchId, batchNumber };
    });

    await auditService
      .record({
        action: 'production.output_recorded',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: {
          produced: dto.producedQuantity,
          rejected: dto.rejectedQuantity,
          good,
          batchNumber: result.batchNumber,
          heldForQc: needsQc,
        },
        reason: dto.notes ?? null,
      })
      .catch(() => {});

    return {
      alreadyRecorded: false,
      outputId: result.output.id,
      batchId: result.batchId,
      batchNumber: result.batchNumber,
      producedQuantity: dto.producedQuantity,
      rejectedQuantity: dto.rejectedQuantity,
      goodQuantity: good,
      /** True when the stock is on the shelf but not yet sellable. */
      heldForQualityControl: needsQc && good > 0,
    };
  },

  async listForOrder(productionOrderId: string) {
    return prisma.productionOutput.findMany({
      where: { productionOrderId },
      orderBy: { productionDate: 'desc' },
      select: {
        id: true, producedQuantity: true, rejectedQuantity: true, goodQuantity: true,
        productionDate: true, expiryDate: true, notes: true,
        warehouse: { select: { id: true, name: true } },
        batch: { select: { id: true, batchNumber: true, qcStatus: true } },
        variant: { select: { id: true, sku: true, product: { select: { name: true } } } },
      },
    });
  },
};

/**
 * A batch number the business can read.
 *
 * The format is theirs — `{SKU}-{YYYYMMDD}-{SEQ}` by default — because a batch
 * number is printed on a case and read back off it by someone under time
 * pressure, and a UUID is not that.
 */
async function generateBatchNumber(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  format: string,
  sku: string,
  date: Date,
): Promise<string> {
  const yyyymmdd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const base = format
    .replace('{SKU}', sku)
    .replace('{YYYYMMDD}', yyyymmdd)
    .replace('{YYYY}', String(date.getUTCFullYear()));

  // Sequence within the day, so two runs of the same product on the same date
  // are distinguishable — which is exactly what a recall needs.
  for (let seq = 1; seq <= 999; seq++) {
    const candidate = base.replace('{SEQ}', String(seq).padStart(3, '0'));
    const clash = await tx.batch.findFirst({
      where: { batchNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ValidationError('Could not allocate a batch number for today.');
}
