import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { quarantineService } from './quarantine.service';

/**
 * Quality control (§14).
 *
 * A business defines what it checks on each product — pH, weight, packaging
 * integrity — and every inspection records the actual reading against the
 * expected one. The parameters are copied onto the inspection rather than
 * referenced, so an inspection from last year still reads correctly after a
 * parameter is renamed or retired. What was measured, and what was expected at
 * the time, are both part of the record.
 *
 * The outcome is not just a note. Passing releases the stock production has
 * been holding; failing quarantines it. Recording a result that did not move
 * the stock would leave the two disagreeing, which is the state a quality
 * system exists to prevent.
 */

export const qualityParameterSchema = z.object({
  productId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().max(24).nullable().optional(),
  /** A numeric range, an expected text value, or neither for a judgement call. */
  expectedMin: z.coerce.number().nullable().optional(),
  expectedMax: z.coerce.number().nullable().optional(),
  expectedText: z.string().trim().max(200).nullable().optional(),
  isRequired: z.boolean().default(true),
  position: z.coerce.number().int().min(0).default(0),
});

export const createInspectionSchema = z.object({
  variantId: z.string().min(1),
  batchId: z.string().min(1).nullable().optional(),
  productionOrderId: z.string().min(1).nullable().optional(),
  inspectedAt: z.coerce.date().optional(),
  comments: z.string().trim().max(2000).nullable().optional(),
});

export const recordResultsSchema = z.object({
  items: z
    .array(
      z.object({
        /** The inspection line being answered. */
        itemId: z.string().min(1),
        actualValue: z.string().trim().max(200).nullable().optional(),
        actualNumeric: z.coerce.number().nullable().optional(),
        /** Overrides the automatic judgement where a person disagrees with it. */
        passed: z.boolean().nullable().optional(),
      }),
    )
    .min(1),
  comments: z.string().trim().max(2000).nullable().optional(),
});

export const concludeInspectionSchema = z.object({
  /**
   * CONDITIONAL is a real outcome, not a hedge: stock that may be used for
   * some purposes and not others is a decision somebody has taken, and it has
   * to be recordable or it gets recorded as a pass.
   */
  status: z.enum(['PASSED', 'FAILED', 'CONDITIONAL']),
  comments: z.string().trim().max(2000).nullable().optional(),
  /** Required on a fail — why the batch is being held. */
  reason: z.string().trim().max(500).optional(),
});

const inspectionSelect = {
  id: true, inspectionNumber: true, status: true, inspectedAt: true,
  comments: true, inspectorUserId: true, createdAt: true,
  variant: { select: { id: true, sku: true, product: { select: { id: true, name: true } } } },
  batch: { select: { id: true, batchNumber: true, qcStatus: true, isQuarantined: true } },
  productionOrder: { select: { id: true, orderNumber: true } },
  items: {
    select: {
      id: true, name: true, unit: true, expectedMin: true, expectedMax: true,
      expectedText: true, actualValue: true, actualNumeric: true, passed: true,
    },
  },
} as const;

export const qualityControlService = {
  // ── Parameters ───────────────────────────────────────────────────────────
  async listParameters(productId: string) {
    return prisma.qualityParameter.findMany({
      where: { productId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  async createParameter(dto: z.infer<typeof qualityParameterSchema>) {
    if (dto.expectedMin != null && dto.expectedMax != null && dto.expectedMin > dto.expectedMax) {
      throw new ValidationError('The minimum cannot be above the maximum.');
    }
    const parameter = await prisma.qualityParameter.create({
      data: {
        organizationId: currentOrgId(),
        productId: dto.productId,
        name: dto.name,
        unit: dto.unit ?? null,
        expectedMin: dto.expectedMin ?? null,
        expectedMax: dto.expectedMax ?? null,
        expectedText: dto.expectedText ?? null,
        isRequired: dto.isRequired,
        position: dto.position,
      },
    });
    await auditService
      .record({
        action: 'qc.parameter_created',
        entityType: 'QUALITY_PARAMETER',
        entityId: parameter.id,
        after: { name: dto.name, product: dto.productId },
      })
      .catch(() => {});
    return parameter;
  },

  async deleteParameter(id: string) {
    // Read before the soft delete: once deletedAt is set, an auditor reading
    // the log has no way to find out which parameter this id referred to.
    const before = await prisma.qualityParameter.findFirst({
      where: { id },
      select: {
        name: true, productId: true, unit: true,
        expectedMin: true, expectedMax: true, expectedText: true, isRequired: true,
      },
    });
    // Soft: inspections copied their values, but the definition should stop
    // appearing on new ones without breaking the old.
    await prisma.qualityParameter.update({ where: { id }, data: { deletedAt: new Date() } });
    await auditService
      .record({
        action: 'qc.parameter_removed',
        entityType: 'QUALITY_PARAMETER',
        entityId: id,
        before: before
          ? {
              name: before.name,
              productId: before.productId,
              unit: before.unit,
              expectedMin: before.expectedMin?.toString() ?? null,
              expectedMax: before.expectedMax?.toString() ?? null,
              expectedText: before.expectedText,
              isRequired: before.isRequired,
            }
          : undefined,
      })
      .catch(() => {});
    return { removed: true };
  },

  // ── Inspections ──────────────────────────────────────────────────────────
  async list(dto: { status?: string; batchId?: string; limit?: number }) {
    return prisma.qualityInspection.findMany({
      where: {
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.batchId ? { batchId: dto.batchId } : {}),
      },
      select: inspectionSelect,
      orderBy: { inspectedAt: 'desc' },
      take: dto.limit ?? 50,
    });
  },

  async get(id: string) {
    const inspection = await prisma.qualityInspection.findFirst({
      where: { id },
      select: inspectionSelect,
    });
    if (!inspection) throw new NotFoundError('Inspection');
    return inspection;
  },

  /**
   * Open an inspection, pre-filled with what this product is checked on.
   *
   * The lines are created up front so an inspector sees the whole checklist
   * rather than deciding for themselves what to measure.
   */
  async create(dto: z.infer<typeof createInspectionSchema>, inspectorUserId: string) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: dto.variantId, deletedAt: null },
      select: { id: true, sku: true, productId: true },
    });
    if (!variant) throw new NotFoundError('Product variant');

    const parameters = await this.listParameters(variant.productId);
    const inspectionNumber = await nextInspectionNumber();

    const inspection = await prisma.qualityInspection.create({
      data: {
        organizationId: currentOrgId(),
        inspectionNumber,
        variantId: dto.variantId,
        batchId: dto.batchId ?? null,
        productionOrderId: dto.productionOrderId ?? null,
        inspectorUserId,
        inspectedAt: dto.inspectedAt ?? new Date(),
        comments: dto.comments ?? null,
        items: {
          create: parameters.map((p) => ({
            organizationId: currentOrgId(),
            parameterId: p.id,
            // Copied, not referenced: the record must still read correctly
            // when the parameter is later changed.
            name: p.name,
            unit: p.unit,
            expectedMin: p.expectedMin,
            expectedMax: p.expectedMax,
            expectedText: p.expectedText,
          })),
        },
      },
      select: inspectionSelect,
    });

    await auditService
      .record({
        action: 'qc.inspection_opened',
        entityType: 'QUALITY_INSPECTION',
        entityId: inspection.id,
        after: { inspectionNumber, sku: variant.sku, parameters: parameters.length },
      })
      .catch(() => {});
    return inspection;
  },

  /** Enter readings. Each is judged against what was expected. */
  async recordResults(id: string, dto: z.infer<typeof recordResultsSchema>) {
    const inspection = await prisma.qualityInspection.findFirst({
      where: { id },
      select: { id: true, status: true, items: { select: { id: true } } },
    });
    if (!inspection) throw new NotFoundError('Inspection');
    if (inspection.status !== 'PENDING') {
      throw new ConflictError('This inspection has already been concluded.');
    }

    await prisma.$transaction(async (tx) => {
      for (const result of dto.items) {
        const line = await tx.qualityInspectionItem.findFirst({
          where: { id: result.itemId, inspectionId: id },
        });
        if (!line) throw new ValidationError('That reading is not part of this inspection.');

        await tx.qualityInspectionItem.update({
          where: { id: line.id },
          data: {
            actualValue: result.actualValue ?? null,
            actualNumeric: result.actualNumeric ?? null,
            // The person's judgement wins where they gave one; otherwise the
            // reading is compared with the expected range.
            passed:
              result.passed ??
              judge({
                actualNumeric: result.actualNumeric ?? null,
                actualValue: result.actualValue ?? null,
                expectedMin: line.expectedMin === null ? null : Number(line.expectedMin),
                expectedMax: line.expectedMax === null ? null : Number(line.expectedMax),
                expectedText: line.expectedText,
              }),
          },
        });
      }
      if (dto.comments !== undefined) {
        await tx.qualityInspection.update({ where: { id }, data: { comments: dto.comments } });
      }
    });
    return this.get(id);
  },

  /**
   * Conclude, and move the stock accordingly.
   *
   * This is where quality stops being a note and becomes a fact about
   * inventory: a pass frees what production was holding, a fail quarantines it.
   */
  async conclude(
    id: string,
    dto: z.infer<typeof concludeInspectionSchema>,
    actorUserId: string,
  ) {
    const inspection = await prisma.qualityInspection.findFirst({
      where: { id },
      select: {
        id: true, status: true, inspectionNumber: true, batchId: true,
        items: { select: { id: true, name: true, passed: true } },
      },
    });
    if (!inspection) throw new NotFoundError('Inspection');
    if (inspection.status !== 'PENDING') {
      throw new ConflictError('This inspection has already been concluded.');
    }
    if (dto.status === 'FAILED' && !dto.reason) {
      // A held batch that nobody explained is a batch nobody can decide about
      // later.
      throw new ValidationError('Say why the batch failed — the reason is what the decision is made on.');
    }

    // A pass while a required reading failed is almost always a mistake, and
    // the one mistake a quality system must not wave through.
    const failedLines = inspection.items.filter((i) => i.passed === false);
    if (dto.status === 'PASSED' && failedLines.length > 0) {
      throw new ValidationError(
        `${failedLines.map((l) => l.name).join(', ')} did not meet the expected range. ` +
          'Record a conditional approval if it is acceptable anyway, and say why.',
      );
    }

    const updated = await prisma.qualityInspection.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.comments !== undefined ? { comments: dto.comments } : {}),
      },
      select: inspectionSelect,
    });

    // ── The consequence for the stock ──────────────────────────────────────
    let stockOutcome: unknown = null;
    if (inspection.batchId) {
      if (dto.status === 'PASSED' || dto.status === 'CONDITIONAL') {
        stockOutcome = await quarantineService.releaseBatch(
          inspection.batchId,
          {
            qcStatus: dto.status,
            reason: dto.comments ?? `Released by inspection ${inspection.inspectionNumber}`,
          },
          actorUserId,
        );
      } else {
        stockOutcome = await quarantineService.holdBatch(
          inspection.batchId,
          { reason: dto.reason!, qcStatus: 'FAILED' },
          actorUserId,
        );
      }
    }

    await auditService
      .record({
        action: `qc.inspection_${dto.status.toLowerCase()}`,
        entityType: 'QUALITY_INSPECTION',
        entityId: id,
        before: { status: 'PENDING' },
        after: {
          status: dto.status,
          batchId: inspection.batchId,
          failedReadings: failedLines.map((l) => l.name),
        },
        reason: dto.reason ?? dto.comments ?? null,
      })
      .catch(() => {});

    return { inspection: updated, stock: stockOutcome };
  },
};

/**
 * Did this reading meet what was expected?
 *
 * Null rather than false when there is nothing to compare against — an
 * un-judged line is not a failed one, and treating it as failed would block
 * every inspection that includes a free-text observation.
 */
function judge(input: {
  actualNumeric: number | null;
  actualValue: string | null;
  expectedMin: number | null;
  expectedMax: number | null;
  expectedText: string | null;
}): boolean | null {
  if (input.expectedMin !== null || input.expectedMax !== null) {
    if (input.actualNumeric === null) return null;
    if (input.expectedMin !== null && input.actualNumeric < input.expectedMin) return false;
    if (input.expectedMax !== null && input.actualNumeric > input.expectedMax) return false;
    return true;
  }
  if (input.expectedText) {
    if (!input.actualValue) return null;
    return input.actualValue.trim().toLowerCase() === input.expectedText.trim().toLowerCase();
  }
  return null;
}

async function nextInspectionNumber(): Promise<string> {
  const count = await prisma.qualityInspection.count();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `QC-${String(count + 1 + attempt).padStart(5, '0')}`;
    const clash = await prisma.qualityInspection.findFirst({
      where: { inspectionNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError('Could not allocate an inspection number.');
}
