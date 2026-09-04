import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { applyMovement } from './stock-ledger';
import { manufacturingAlerts } from './manufacturing-alerts.service';
import type { QcStatus } from '@prisma/client';

/**
 * Quarantine (§15).
 *
 * Held stock is reserved, not deleted. It physically exists and the count has
 * to say so — a warehouse that cannot find 1,800 cases it can see on the pallet
 * has a worse problem than one that knows they are held. Reserving is what
 * makes them unsellable and untransferable: sales, transfers and the
 * manufacturing ledger all refuse to take stock below what is reserved, so the
 * guarantee is enforced by the same rule everywhere rather than by remembering
 * to check a flag.
 *
 * Every decision is recorded with who took it and why. Releasing stock that
 * failed an inspection is exactly the kind of thing that has to be answerable
 * for later.
 */

export const quarantineDecisionSchema = z.object({
  /**
   * What happens to the held stock.
   *
   *  - RELEASED  it is fine after all; it becomes ordinary available stock.
   *  - REWORK    it will be put right; it stays held until it is.
   *  - REJECTED  it is not sellable and is written off.
   *  - DISPOSED  it has been destroyed; written off, recorded as disposal.
   */
  decision: z.enum(['RELEASED', 'REWORK', 'REJECTED', 'DISPOSED']),
  reason: z.string().trim().min(1, 'Say why this decision was taken').max(1000),
  /** Part of a batch, where only some of it is affected. */
  quantity: z.coerce.number().positive().optional(),
});

export const holdBatchSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  quantity: z.coerce.number().positive().optional(),
});

export const quarantineService = {
  async list(dto: { status?: string; limit?: number } = {}) {
    return prisma.quarantineRecord.findMany({
      where: { ...(dto.status ? { status: dto.status as never } : {}) },
      orderBy: { heldAt: 'desc' },
      take: dto.limit ?? 50,
      select: {
        id: true, quantity: true, reason: true, status: true,
        heldAt: true, decidedAt: true, decisionReason: true,
        heldByUserId: true, decidedByUserId: true,
        batch: {
          select: {
            id: true, batchNumber: true, qcStatus: true, isQuarantined: true,
            quantityAvailable: true, expiryDate: true,
            variant: { select: { id: true, sku: true, product: { select: { name: true } } } },
            warehouse: { select: { id: true, name: true } },
          },
        },
      },
    });
  },

  /**
   * Hold a batch.
   *
   * Called by a failed inspection, and directly when somebody spots a problem
   * outside one — a leaking pallet does not wait for a scheduled check.
   */
  async holdBatch(
    batchId: string,
    input: { reason: string; quantity?: number; qcStatus?: QcStatus },
    actorUserId: string,
  ) {
    const batch = await loadBatch(batchId);
    const quantity = input.quantity ?? Number(batch.quantityAvailable);
    if (quantity <= 0) {
      throw new ValidationError('There is nothing left of this batch to hold.');
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.batch.update({
        where: { id: batchId },
        data: {
          isQuarantined: true,
          ...(input.qcStatus ? { qcStatus: input.qcStatus } : {}),
        },
      });

      /*
       * Reserve only what is not already held for this batch.
       *
       * Output awaiting inspection is held the moment it is made, so a batch
       * failing its first inspection is already reserved and nothing more is
       * needed. Reserving again would show the warehouse holding twice what it
       * has. A batch failing later — a complaint, a retest — is free stock and
       * does have to be pulled back, which is the case this arithmetic covers.
       */
      const alreadyHeld = await tx.quarantineRecord.aggregate({
        where: { batchId, status: { in: ['HELD', 'REWORK'] } },
        _sum: { quantity: true },
      });
      const outstandingHold = Math.max(0, quantity - Number(alreadyHeld._sum.quantity ?? 0));

      if (batch.warehouseId && outstandingHold > 0) {
        const level = await tx.stockLevel.findUnique({
          where: {
            warehouseId_variantId: { warehouseId: batch.warehouseId, variantId: batch.variantId },
          },
          select: { id: true, quantity: true, reserved: true },
        });
        if (level) {
          const free = Number(level.quantity) - Number(level.reserved);
          const toReserve = Math.min(Math.max(0, free), outstandingHold);
          if (toReserve > 0) {
            await tx.stockLevel.update({
              where: { id: level.id },
              data: { reserved: { increment: toReserve } },
            });
          }
          await tx.stockMovement.create({
            data: {
              organizationId: batch.organizationId,
              warehouseId: batch.warehouseId,
              variantId: batch.variantId,
              type: 'QC_QUARANTINE',
              // No physical movement — the stock has not gone anywhere, it has
              // stopped being available. Zero says exactly that.
              quantity: 0,
              referenceType: 'BATCH',
              referenceId: batchId,
              reason: input.reason,
              batchNumber: batch.batchNumber,
              actorUserId,
            },
          });
        }
      }

      /*
       * When output already held this batch, that record is what the decision
       * will be taken against — it is updated with the real reason rather than
       * a second record being added beside it. Two "held" rows for one batch
       * would make "how much is held" a question with two answers.
       */
      const existing = await tx.quarantineRecord.findFirst({
        where: { batchId, status: 'HELD' },
        select: { id: true },
      });
      if (existing) {
        return tx.quarantineRecord.update({
          where: { id: existing.id },
          data: { quantity, reason: input.reason, heldByUserId: actorUserId, heldAt: new Date() },
          select: { id: true, quantity: true, status: true, reason: true, heldAt: true },
        });
      }
      return tx.quarantineRecord.create({
        data: {
          organizationId: batch.organizationId,
          batchId,
          quantity,
          reason: input.reason,
          status: 'HELD',
          heldByUserId: actorUserId,
        },
        select: { id: true, quantity: true, status: true, reason: true, heldAt: true },
      });
    });

    // Told to whoever can release it. Best-effort: a notification that fails
    // must never roll back the hold itself.
    const product = await prisma.productVariant.findUnique({
      where: { id: batch.variantId },
      select: { product: { select: { name: true } } },
    });
    await manufacturingAlerts
      .batchQuarantined(batch.organizationId, {
        batchNumber: batch.batchNumber,
        quantity,
        reason: input.reason,
        batchId,
      })
      .catch(() => {});
    if (input.qcStatus === 'FAILED') {
      await manufacturingAlerts
        .batchFailedQc(batch.organizationId, {
          batchNumber: batch.batchNumber,
          product: product?.product.name ?? 'Product',
          reason: input.reason,
          batchId,
        })
        .catch(() => {});
    }

    await auditService
      .record({
        action: 'qc.batch_quarantined',
        entityType: 'BATCH',
        entityId: batchId,
        before: { isQuarantined: batch.isQuarantined, qcStatus: batch.qcStatus },
        after: { isQuarantined: true, qcStatus: input.qcStatus ?? batch.qcStatus, quantity },
        reason: input.reason,
      })
      .catch(() => {});
    return result;
  },

  /**
   * Let a batch out — after an inspection passed, or after a held one is
   * decided to be fine.
   *
   * This is the only thing that turns held stock back into sellable stock, and
   * it always leaves a record of who decided and why.
   */
  async releaseBatch(
    batchId: string,
    input: { reason: string; qcStatus?: QcStatus; quantity?: number },
    actorUserId: string,
  ) {
    const batch = await loadBatch(batchId);
    const quantity = input.quantity ?? Number(batch.quantityAvailable);

    const result = await prisma.$transaction(async (tx) => {
      await tx.batch.update({
        where: { id: batchId },
        data: {
          isQuarantined: false,
          ...(input.qcStatus ? { qcStatus: input.qcStatus } : {}),
        },
      });

      if (batch.warehouseId && quantity > 0) {
        const level = await tx.stockLevel.findUnique({
          where: {
            warehouseId_variantId: { warehouseId: batch.warehouseId, variantId: batch.variantId },
          },
          select: { id: true, reserved: true },
        });
        if (level) {
          // Never release more than is actually held, or the reserve on other
          // batches in the same warehouse would be eaten.
          const toRelease = Math.min(Number(level.reserved), quantity);
          if (toRelease > 0) {
            await tx.stockLevel.update({
              where: { id: level.id },
              data: { reserved: { decrement: toRelease } },
            });
          }
          await tx.stockMovement.create({
            data: {
              organizationId: batch.organizationId,
              warehouseId: batch.warehouseId,
              variantId: batch.variantId,
              type: 'QC_RELEASE',
              quantity: 0,
              referenceType: 'BATCH',
              referenceId: batchId,
              reason: input.reason,
              batchNumber: batch.batchNumber,
              actorUserId,
            },
          });
        }
      }

      await tx.quarantineRecord.updateMany({
        where: { batchId, status: 'HELD' },
        data: {
          status: 'RELEASED',
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          decisionReason: input.reason,
        },
      });
      return { released: quantity };
    });

    await auditService
      .record({
        action: 'qc.batch_released',
        entityType: 'BATCH',
        entityId: batchId,
        before: { isQuarantined: batch.isQuarantined, qcStatus: batch.qcStatus },
        after: { isQuarantined: false, qcStatus: input.qcStatus ?? 'PASSED', released: quantity },
        reason: input.reason,
      })
      .catch(() => {});
    return result;
  },

  /** Act on a held batch: release, rework, reject or dispose of it. */
  async decide(
    quarantineId: string,
    dto: z.infer<typeof quarantineDecisionSchema>,
    actorUserId: string,
  ) {
    const record = await prisma.quarantineRecord.findFirst({
      where: { id: quarantineId },
      select: { id: true, batchId: true, quantity: true, status: true },
    });
    if (!record) throw new NotFoundError('Quarantine record');
    if (record.status !== 'HELD' && record.status !== 'REWORK') {
      throw new ValidationError(`This batch has already been ${record.status.toLowerCase()}.`);
    }

    const quantity = dto.quantity ?? Number(record.quantity);

    if (dto.decision === 'RELEASED') {
      await this.releaseBatch(
        record.batchId,
        { reason: dto.reason, qcStatus: 'CONDITIONAL', quantity },
        actorUserId,
      );
      return { decision: dto.decision, quantity };
    }

    if (dto.decision === 'REWORK') {
      // Stays held. Nothing moves — the stock is still there and still not
      // sellable, which is exactly what rework means.
      await prisma.quarantineRecord.update({
        where: { id: quarantineId },
        data: {
          status: 'REWORK',
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          decisionReason: dto.reason,
        },
      });
      await auditService
        .record({
          action: 'qc.batch_rework',
          entityType: 'BATCH',
          entityId: record.batchId,
          after: { quantity },
          reason: dto.reason,
        })
        .catch(() => {});
      return { decision: dto.decision, quantity };
    }

    // ── Written off ────────────────────────────────────────────────────────
    const batch = await loadBatch(record.batchId);
    await prisma.$transaction(async (tx) => {
      if (batch.warehouseId && quantity > 0) {
        // Release the hold first, then take the stock out: `applyMovement`
        // refuses to reduce below what is reserved, and here the reserve is
        // precisely the stock being written off.
        const level = await tx.stockLevel.findUnique({
          where: {
            warehouseId_variantId: { warehouseId: batch.warehouseId, variantId: batch.variantId },
          },
          select: { id: true, reserved: true },
        });
        if (level) {
          const toRelease = Math.min(Number(level.reserved), quantity);
          if (toRelease > 0) {
            await tx.stockLevel.update({
              where: { id: level.id },
              data: { reserved: { decrement: toRelease } },
            });
          }
        }
        await applyMovement(tx, {
          organizationId: batch.organizationId,
          warehouseId: batch.warehouseId,
          variantId: batch.variantId,
          quantityChange: -quantity,
          type: dto.decision === 'DISPOSED' ? 'DAMAGE' : 'QC_REJECTION',
          referenceType: 'BATCH',
          referenceId: record.batchId,
          reason: dto.reason,
          batchNumber: batch.batchNumber,
          actorUserId,
        });
      }

      await tx.batch.update({
        where: { id: record.batchId },
        data: {
          qcStatus: 'FAILED',
          isQuarantined: false,
          quantityAvailable: { decrement: Math.min(quantity, Number(batch.quantityAvailable)) },
        },
      });
      await tx.quarantineRecord.update({
        where: { id: quarantineId },
        data: {
          status: dto.decision,
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          decisionReason: dto.reason,
        },
      });
    });

    await auditService
      .record({
        action: `qc.batch_${dto.decision.toLowerCase()}`,
        entityType: 'BATCH',
        entityId: record.batchId,
        before: { quantityAvailable: Number(batch.quantityAvailable) },
        after: { writtenOff: quantity, decision: dto.decision },
        reason: dto.reason,
      })
      .catch(() => {});
    return { decision: dto.decision, quantity };
  },
};

async function loadBatch(batchId: string) {
  const batch = await prisma.batch.findFirst({
    where: { id: batchId },
    select: {
      id: true, organizationId: true, batchNumber: true, variantId: true,
      warehouseId: true, quantityAvailable: true, qcStatus: true, isQuarantined: true,
    },
  });
  if (!batch) throw new NotFoundError('Batch');
  return batch;
}
