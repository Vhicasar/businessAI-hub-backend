import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';

/**
 * How this business wants manufacturing to behave.
 *
 * Read far more often than written — every BOM activation, every variance
 * calculation and every batch number asks — so `get` creates the row on first
 * use rather than making every caller handle "not configured yet".
 */

export const manufacturingSettingsSchema = z.object({
  allowMultipleActiveBoms: z.boolean().optional(),
  acceptableVariancePercent: z.coerce.number().min(0).max(100).optional(),
  batchNumberFormat: z.string().trim().min(1).max(120).optional(),
  requireQcBeforeRelease: z.boolean().optional(),
  materialIssueApprovalMode: z.enum(['NONE', 'SUPERVISOR', 'WAREHOUSE_MANAGER']).optional(),
  finishedGoodsReceivingMode: z.enum(['AUTOMATIC', 'WAREHOUSE_CONFIRMATION']).optional(),
});

export const manufacturingSettings = {
  /** The business's settings, created with sensible defaults on first read. */
  async get() {
    const organizationId = currentOrgId();
    const existing = await prisma.manufacturingSettings.findUnique({ where: { organizationId } });
    if (existing) return existing;
    return prisma.manufacturingSettings.create({ data: { organizationId } });
  },

  async update(dto: z.infer<typeof manufacturingSettingsSchema>) {
    const before = await this.get();
    const updated = await prisma.$transaction(async (tx) => {
      // A mode change while batches are still awaiting QC must not leave the
      // legacy automatic posting path armed. Remove only the deterministically
      // identifiable, fully reserved pending output; passed historical stock
      // is deliberately left alone for reconciliation rather than rewritten.
      if (before.finishedGoodsReceivingMode === 'AUTOMATIC' && dto.finishedGoodsReceivingMode === 'WAREHOUSE_CONFIRMATION') {
        const pending = await tx.productionOutput.findMany({ where: { batch: { qcStatus: 'PENDING', warehouseId: { not: null } }, finishedGoodsReceipt: null }, include: { batch: true } });
        for (const output of pending) {
          if (!output.batch?.warehouseId || Number(output.goodQuantity) <= 0) continue;
          const quantity = Number(output.goodQuantity);
          const level = await tx.stockLevel.findUnique({ where: { warehouseId_variantId: { warehouseId: output.batch.warehouseId, variantId: output.variantId } } });
          if (!level || Number(level.quantity) < quantity || Number(level.reserved) < quantity) continue;
          const changed = await tx.stockLevel.updateMany({ where: { id: level.id, quantity: level.quantity, reserved: level.reserved }, data: { quantity: { decrement: quantity }, reserved: { decrement: quantity } } });
          if (changed.count !== 1) throw new Error('Pending finished-goods stock changed while receiving mode was being updated.');
          await tx.stockMovement.create({ data: { organizationId: before.organizationId, warehouseId: output.batch.warehouseId, variantId: output.variantId, type: 'ADJUSTMENT', quantity: -quantity, referenceType: 'FINISHED_GOODS_MODE_TRANSITION', referenceId: output.id, reason: 'Moved pending-QC output to warehouse-confirmation staging', batchNumber: output.batch.batchNumber } });
          await tx.batch.update({ where: { id: output.batch.id }, data: { warehouseId: null } });
        }
      }
      return tx.manufacturingSettings.update({ where: { organizationId: before.organizationId }, data: dto });
    });
    await auditService
      .record({
        action: 'manufacturing.settings_updated',
        entityType: 'MANUFACTURING_SETTINGS',
        entityId: updated.id,
        before: {
          allowMultipleActiveBoms: before.allowMultipleActiveBoms,
          acceptableVariancePercent: Number(before.acceptableVariancePercent),
          requireQcBeforeRelease: before.requireQcBeforeRelease,
          materialIssueApprovalMode: before.materialIssueApprovalMode,
          finishedGoodsReceivingMode: before.finishedGoodsReceivingMode,
        },
        after: {
          allowMultipleActiveBoms: updated.allowMultipleActiveBoms,
          acceptableVariancePercent: Number(updated.acceptableVariancePercent),
          requireQcBeforeRelease: updated.requireQcBeforeRelease,
          materialIssueApprovalMode: updated.materialIssueApprovalMode,
          finishedGoodsReceivingMode: updated.finishedGoodsReceivingMode,
        },
      })
      .catch(() => {});
    return updated;
  },
};
