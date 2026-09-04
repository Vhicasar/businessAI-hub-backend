import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { manufacturingSettings } from './settings.service';
import { manufacturingAlerts } from './manufacturing-alerts.service';

/**
 * What a production run cost, and where it drifted (§21, §22).
 *
 * Calculated once, when the run finishes, and stored. Material prices move,
 * and last quarter's cost must not change because this quarter's sugar did —
 * a cost that recomputes itself is a cost nobody can reconcile against the
 * accounts.
 *
 * Estimated against actual, per material and overall, because the total alone
 * says a run went over without saying which drum leaked.
 */

export const calculateCostSchema = z.object({
  /** Wages for the run, where the business tracks them. */
  labourCost: z.coerce.number().min(0).default(0),
  /** Machine time, power, anything else attributable to the run. */
  overheadCost: z.coerce.number().min(0).default(0),
  otherCost: z.coerce.number().min(0).default(0),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const costingService = {
  /**
   * Work out and store what a run cost.
   *
   * Material cost comes from what was actually consumed, valued at the
   * variant's cost price. The estimate comes from the recipe and the standard
   * costs, so the two are comparable rather than being different things given
   * the same name.
   */
  async calculate(
    productionOrderId: string,
    dto: z.infer<typeof calculateCostSchema>,
  ) {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: {
        id: true, orderNumber: true, status: true,
        plannedQuantity: true, actualQuantity: true, rejectedQuantity: true,
        materials: {
          select: {
            variantId: true, requiredQuantity: true, consumedQuantity: true, unit: true,
            variant: {
              select: {
                id: true, sku: true, costPrice: true,
                product: {
                  select: { id: true, name: true, standardCost: true, manufacturingType: true },
                },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundError('Production order');

    const org = await prisma.organization.findFirstOrThrow({
      where: { id: currentOrgId() },
      select: { currency: true },
    });
    const settings = await manufacturingSettings.get();
    const threshold = Number(settings.acceptableVariancePercent);

    // ── Materials ──────────────────────────────────────────────────────────
    let materialCost = 0;
    let packagingCost = 0;
    let estimatedMaterial = 0;
    const variances: {
      variantId: string;
      sku: string;
      name: string;
      unit: string | null;
      plannedQuantity: number;
      actualQuantity: number;
      varianceQuantity: number;
      variancePercent: number | null;
      exceedsThreshold: boolean;
      unitCost: number;
      actualCost: number;
      estimatedCost: number;
    }[] = [];

    for (const material of order.materials) {
      const planned = Number(material.requiredQuantity);
      const actual = Number(material.consumedQuantity);
      // What it was really worth: the variant's cost, falling back to the
      // product's standard cost when no purchase price is recorded.
      const unitCost =
        Number(material.variant.costPrice ?? 0) ||
        Number(material.variant.product.standardCost ?? 0);

      const actualCost = actual * unitCost;
      const estimateCost = planned * unitCost;

      // Packaging is separated because a business that wants to know why a
      // case got dearer needs to see whether it was the drink or the bottle.
      if (material.variant.product.manufacturingType === 'PACKAGING') {
        packagingCost += actualCost;
      } else {
        materialCost += actualCost;
      }
      estimatedMaterial += estimateCost;

      const varianceQuantity = actual - planned;
      const variancePercent = planned > 0 ? (varianceQuantity / planned) * 100 : null;
      variances.push({
        variantId: material.variantId,
        sku: material.variant.sku,
        name: material.variant.product.name,
        unit: material.unit,
        plannedQuantity: round3(planned),
        actualQuantity: round3(actual),
        varianceQuantity: round3(varianceQuantity),
        variancePercent: variancePercent === null ? null : round2(variancePercent),
        // Only overconsumption counts against the tolerance: using less than
        // the recipe is not a problem to flag, it is a good day.
        exceedsThreshold: variancePercent !== null && variancePercent > threshold,
        unitCost,
        actualCost: round2(actualCost),
        estimatedCost: round2(estimateCost),
      });
    }

    /*
     * Defaulted here as well as in the schema. A missing figure would make the
     * total NaN, and a NaN cost is worse than no cost — it stores, it displays
     * as blank, and it silently poisons every average built on it.
     */
    const labourCost = dto.labourCost ?? 0;
    const overheadCost = dto.overheadCost ?? 0;
    const otherCost = dto.otherCost ?? 0;

    const totalCost = materialCost + packagingCost + labourCost + overheadCost + otherCost;
    const estimatedCost = estimatedMaterial + labourCost + overheadCost + otherCost;

    // Per *good* unit: dividing by everything produced would make a run that
    // threw half its output away look as cheap as one that did not.
    const goodOutput = Number(order.actualQuantity);
    const unitCost = goodOutput > 0 ? totalCost / goodOutput : null;
    const estimatedUnitCost =
      Number(order.plannedQuantity) > 0 ? estimatedCost / Number(order.plannedQuantity) : null;

    const saved = await prisma.$transaction(async (tx) => {
      await tx.productionVariance.deleteMany({ where: { productionOrderId } });
      await tx.productionVariance.createMany({
        data: variances.map((v) => ({
          organizationId: currentOrgId(),
          productionOrderId,
          variantId: v.variantId,
          plannedQuantity: v.plannedQuantity,
          actualQuantity: v.actualQuantity,
          varianceQuantity: v.varianceQuantity,
          variancePercent: v.variancePercent,
          exceedsThreshold: v.exceedsThreshold,
        })),
      });
      // Recalculating replaces rather than accumulates: a run has one cost.
      await tx.productionCost.deleteMany({ where: { productionOrderId } });
      return tx.productionCost.create({
        data: {
          organizationId: currentOrgId(),
          productionOrder: { connect: { id: productionOrderId } },
          materialCost: round2(materialCost),
          packagingCost: round2(packagingCost),
          labourCost,
          overheadCost,
          otherCost,
          totalCost: round2(totalCost),
          unitCost: unitCost === null ? null : round4(unitCost),
          estimatedCost: round2(estimatedCost),
          estimatedUnitCost: estimatedUnitCost === null ? null : round4(estimatedUnitCost),
          currency: org.currency,
        },
      });
    });

    const planned = Number(order.plannedQuantity);
    const rejected = Number(order.rejectedQuantity);

    // Only the exceptions. Telling somebody about every material every run is
    // how a tray becomes something people stop opening.
    for (const exception of variances.filter((v) => v.exceedsThreshold)) {
      await manufacturingAlerts
        .varianceExceeded(currentOrgId(), {
          productionOrderId,
          orderNumber: order.orderNumber,
          material: exception.name,
          variancePercent: exception.variancePercent ?? 0,
        })
        .catch(() => {});
    }

    await auditService
      .record({
        action: 'production.cost_calculated',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: {
          totalCost: round2(totalCost),
          estimatedCost: round2(estimatedCost),
          variance: round2(totalCost - estimatedCost),
          currency: org.currency,
        },
        reason: dto.notes ?? null,
      })
      .catch(() => {});

    return {
      productionOrderId,
      orderNumber: order.orderNumber,
      currency: org.currency,
      cost: {
        materialCost: round2(materialCost),
        packagingCost: round2(packagingCost),
        labourCost,
        overheadCost,
        otherCost,
        totalCost: round2(totalCost),
        unitCost: unitCost === null ? null : round4(unitCost),
      },
      estimate: {
        estimatedCost: round2(estimatedCost),
        estimatedUnitCost: estimatedUnitCost === null ? null : round4(estimatedUnitCost),
      },
      /** Positive means the run cost more than the recipe said it would. */
      costVariance: round2(totalCost - estimatedCost),
      costVariancePercent: estimatedCost > 0 ? round2(((totalCost - estimatedCost) / estimatedCost) * 100) : null,
      output: {
        plannedQuantity: planned,
        goodQuantity: goodOutput,
        rejectedQuantity: rejected,
        // What actually reached the store, against what was asked for. The
        // number a factory is judged on.
        yieldPercent: planned > 0 ? round2((goodOutput / planned) * 100) : null,
        rejectionRatePercent:
          goodOutput + rejected > 0 ? round2((rejected / (goodOutput + rejected)) * 100) : null,
      },
      materialVariances: variances,
      /** Materials that drifted further than the business tolerates. */
      exceptions: variances.filter((v) => v.exceedsThreshold),
      acceptableVariancePercent: threshold,
      costId: saved.id,
    };
  },

  /** The stored cost for a run, if it has been worked out. */
  async forOrder(productionOrderId: string) {
    const cost = await prisma.productionCost.findFirst({
      where: { productionOrderId },
      orderBy: { calculatedAt: 'desc' },
    });
    if (!cost) {
      throw new ValidationError(
        'This run has not been costed yet. Calculate it once production is complete.',
      );
    }
    const variances = await prisma.productionVariance.findMany({ where: { productionOrderId } });
    return { cost, variances };
  },
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
