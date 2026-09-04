import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { currentOrgId } from '../billing/entitlements';
import { manufacturingSettings } from './settings.service';

/**
 * The manufacturing dashboard (§23).
 *
 * Every figure is counted in the database rather than assembled in memory, for
 * two reasons: a factory with a year of runs would not fit, and these same
 * numbers back the AI assistant (§25), which must never be left to do
 * arithmetic on a list it was handed.
 *
 * The figures are deliberately plain. "Production today" is good output booked
 * today, not attempted output — a dashboard that flatters the factory is worse
 * than none, because somebody plans against it.
 */

export const dashboardFiltersSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  warehouseId: z.string().optional(),
  productId: z.string().optional(),
  categoryId: z.string().optional(),
  productionLineId: z.string().optional(),
  status: z.string().optional(),
});

export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;

export const manufacturingDashboard = {
  async overview(filters: DashboardFilters = {}) {
    const organizationId = currentOrgId();
    const now = new Date();
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = filters.from ?? startOfMonth;
    const to = filters.to ?? now;

    const outputWhere = {
      organizationId,
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      ...(filters.productId ? { variant: { productId: filters.productId } } : {}),
      ...(filters.productionLineId
        ? { productionOrder: { productionLineId: filters.productionLineId } }
        : {}),
    };

    const [
      today,
      month,
      period,
      orderCounts,
      shortageCandidates,
      pendingRequisitions,
      openPurchaseOrders,
      pendingInspections,
      quarantined,
      downtime,
      settings,
    ] = await Promise.all([
      // Good output only — rejects are not production.
      prisma.productionOutput.aggregate({
        where: { ...outputWhere, productionDate: { gte: startOfToday } },
        _sum: { goodQuantity: true, rejectedQuantity: true },
      }),
      prisma.productionOutput.aggregate({
        where: { ...outputWhere, productionDate: { gte: startOfMonth } },
        _sum: { goodQuantity: true, rejectedQuantity: true },
      }),
      prisma.productionOutput.aggregate({
        where: { ...outputWhere, productionDate: { gte: from, lte: to } },
        _sum: { goodQuantity: true, rejectedQuantity: true, producedQuantity: true },
        _count: true,
      }),
      prisma.productionOrder.groupBy({
        by: ['status'],
        where: {
          organizationId,
          deletedAt: null,
          ...(filters.productionLineId ? { productionLineId: filters.productionLineId } : {}),
          ...(filters.productId ? { productId: filters.productId } : {}),
        },
        _count: true,
      }),
      // Materials at or below their planning floor. Compared in memory only
      // because the floor lives on the product and the quantity on the level;
      // the rows are already narrowed to materials that have a floor at all.
      prisma.product.findMany({
        where: {
          organizationId,
          deletedAt: null,
          OR: [{ minStock: { not: null } }, { safetyStock: { not: null } }],
        },
        select: {
          id: true, name: true, unit: true, minStock: true, safetyStock: true,
          manufacturingType: true,
          variants: {
            where: { deletedAt: null },
            select: {
              id: true, sku: true,
              stockLevels: { select: { quantity: true, reserved: true } },
            },
          },
        },
        take: 500,
      }),
      prisma.internalRequisition.count({
        where: { organizationId, status: { in: ['SUBMITTED', 'APPROVED', 'PARTIALLY_DISPATCHED'] } },
      }),
      prisma.purchaseOrder.count({
        where: { organizationId, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] } },
      }),
      prisma.qualityInspection.count({ where: { organizationId, status: 'PENDING' } }),
      prisma.batch.count({ where: { organizationId, isQuarantined: true } }),
      prisma.maintenanceWorkOrder.aggregate({
        where: {
          organizationId,
          deletedAt: null,
          completionDate: { gte: from, lte: to },
        },
        _sum: { downtimeMinutes: true, cost: true },
        _count: true,
      }),
      manufacturingSettings.get(),
    ]);

    // ── Low stock and shortages ────────────────────────────────────────────
    const lowStock = shortageCandidates
      .map((product) => {
        const onHand = product.variants.reduce(
          (sum, v) => sum + v.stockLevels.reduce((s, l) => s + Number(l.quantity) - Number(l.reserved), 0),
          0,
        );
        const floor = Number(product.minStock ?? product.safetyStock ?? 0);
        return {
          productId: product.id,
          name: product.name,
          sku: product.variants[0]?.sku ?? null,
          unit: product.unit,
          manufacturingType: product.manufacturingType,
          available: round3(onHand),
          floor,
          // Negative means below the floor; the size of the gap is what a
          // buyer needs, not merely that there is one.
          shortBy: round3(Math.max(0, floor - onHand)),
        };
      })
      /*
       * At the floor counts, not just below it.
       *
       * Safety stock is the buffer that is not supposed to be touched, so
       * sitting exactly on it means the buffer is gone — the next run eats
       * into it. Reporting only what is already below would raise the alarm
       * one run too late.
       */
      .filter((row) => row.floor > 0 && row.available <= row.floor)
      .sort((a, b) => b.shortBy - a.shortBy);

    // ── Cost and variance over the period ──────────────────────────────────
    const costs = await prisma.productionCost.aggregate({
      where: { organizationId, calculatedAt: { gte: from, lte: to } },
      _sum: { totalCost: true, estimatedCost: true },
      _count: true,
    });
    const totalCost = Number(costs._sum.totalCost ?? 0);
    const estimatedCost = Number(costs._sum.estimatedCost ?? 0);

    const byStatus = Object.fromEntries(orderCounts.map((row) => [row.status, row._count]));
    const periodGood = Number(period._sum.goodQuantity ?? 0);
    const periodProduced = Number(period._sum.producedQuantity ?? 0);
    const periodRejected = Number(period._sum.rejectedQuantity ?? 0);

    /*
     * What the runs in this period were supposed to make.
     *
     * Efficiency is good output against what was planned, not against what was
     * produced — a run that made 2,000 and scrapped 400 was not 100%
     * efficient, and saying so would hide exactly the problem worth seeing.
     */
    const plannedAgg = await prisma.productionOrder.aggregate({
      where: {
        organizationId,
        deletedAt: null,
        actualCompletionDate: { gte: from, lte: to },
        ...(filters.productionLineId ? { productionLineId: filters.productionLineId } : {}),
        ...(filters.productId ? { productId: filters.productId } : {}),
      },
      _sum: { plannedQuantity: true, actualQuantity: true, rejectedQuantity: true },
    });
    const plannedInPeriod = Number(plannedAgg._sum.plannedQuantity ?? 0);
    const completedGood = Number(plannedAgg._sum.actualQuantity ?? 0);

    return {
      period: { from, to },
      production: {
        today: round3(Number(today._sum.goodQuantity ?? 0)),
        thisMonth: round3(Number(month._sum.goodQuantity ?? 0)),
        inPeriod: round3(periodGood),
        rejectedInPeriod: round3(periodRejected),
        /** Good output against what the completed runs planned to make. */
        efficiencyPercent:
          plannedInPeriod > 0 ? round2((completedGood / plannedInPeriod) * 100) : null,
        /** Rejects as a share of everything that came off the line. */
        rejectionRatePercent:
          periodProduced > 0 ? round2((periodRejected / periodProduced) * 100) : null,
        runsRecorded: period._count,
      },
      orders: {
        total: orderCounts.reduce((sum, row) => sum + row._count, 0),
        draft: byStatus.DRAFT ?? 0,
        approved: byStatus.APPROVED ?? 0,
        ready: byStatus.READY ?? 0,
        inProgress: byStatus.IN_PROGRESS ?? 0,
        paused: byStatus.PAUSED ?? 0,
        completed: byStatus.COMPLETED ?? 0,
        cancelled: byStatus.CANCELLED ?? 0,
      },
      materials: {
        pendingRequisitions,
        openPurchaseOrders,
        lowStockCount: lowStock.length,
        /** The worst ten, because a dashboard is read, not scrolled. */
        lowStock: lowStock.slice(0, 10),
      },
      quality: {
        pendingInspections,
        quarantinedBatches: quarantined,
        rejectedQuantityInPeriod: round3(periodRejected),
      },
      maintenance: {
        completedWorkOrders: downtime._count,
        downtimeMinutes: Number(downtime._sum.downtimeMinutes ?? 0),
        downtimeHours: round2(Number(downtime._sum.downtimeMinutes ?? 0) / 60),
        maintenanceCost: round2(Number(downtime._sum.cost ?? 0)),
      },
      cost: {
        runsCosted: costs._count,
        totalCost: round2(totalCost),
        estimatedCost: round2(estimatedCost),
        /** Positive means production cost more than the recipes said. */
        variance: round2(totalCost - estimatedCost),
        variancePercent:
          estimatedCost > 0 ? round2(((totalCost - estimatedCost) / estimatedCost) * 100) : null,
      },
      settings: {
        acceptableVariancePercent: Number(settings.acceptableVariancePercent),
        requireQcBeforeRelease: settings.requireQcBeforeRelease,
      },
    };
  },

  /**
   * What raw materials are worth, by warehouse.
   *
   * Valued at cost, not at selling price: this is money tied up in the store,
   * and valuing sugar at what a case of drink sells for would be nonsense.
   */
  async inventoryValue(filters: { warehouseId?: string } = {}) {
    const organizationId = currentOrgId();
    const levels = await prisma.stockLevel.findMany({
      where: {
        organizationId,
        quantity: { gt: 0 },
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
      },
      select: {
        quantity: true, reserved: true,
        warehouse: { select: { id: true, name: true, warehouseType: true } },
        variant: {
          select: {
            costPrice: true,
            product: { select: { standardCost: true, manufacturingType: true } },
          },
        },
      },
    });

    const byWarehouse = new Map<string, { name: string; type: string; value: number; heldValue: number }>();
    const byType = new Map<string, number>();
    let total = 0;

    for (const level of levels) {
      const unitCost =
        Number(level.variant.costPrice ?? 0) || Number(level.variant.product.standardCost ?? 0);
      const value = Number(level.quantity) * unitCost;
      const heldValue = Number(level.reserved) * unitCost;
      total += value;

      const wh = byWarehouse.get(level.warehouse.id) ?? {
        name: level.warehouse.name,
        type: level.warehouse.warehouseType,
        value: 0,
        heldValue: 0,
      };
      wh.value += value;
      wh.heldValue += heldValue;
      byWarehouse.set(level.warehouse.id, wh);

      const type = level.variant.product.manufacturingType ?? 'UNCLASSIFIED';
      byType.set(type, (byType.get(type) ?? 0) + value);
    }

    return {
      totalValue: round2(total),
      byWarehouse: [...byWarehouse.entries()]
        .map(([id, w]) => ({
          warehouseId: id,
          name: w.name,
          warehouseType: w.type,
          value: round2(w.value),
          /** Value that is present but not sellable — quarantined or reserved. */
          heldValue: round2(w.heldValue),
        }))
        .sort((a, b) => b.value - a.value),
      byMaterialType: [...byType.entries()]
        .map(([type, value]) => ({ manufacturingType: type, value: round2(value) }))
        .sort((a, b) => b.value - a.value),
    };
  },
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
