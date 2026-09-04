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
    const updated = await prisma.manufacturingSettings.update({
      where: { organizationId: before.organizationId },
      data: dto,
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
        },
        after: {
          allowMultipleActiveBoms: updated.allowMultipleActiveBoms,
          acceptableVariancePercent: Number(updated.acceptableVariancePercent),
          requireQcBeforeRelease: updated.requireQcBeforeRelease,
        },
      })
      .catch(() => {});
    return updated;
  },
};
