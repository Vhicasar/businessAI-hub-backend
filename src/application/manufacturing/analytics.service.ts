import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { currentOrgId } from '../billing/entitlements';

/**
 * Manufacturing analytics (§24).
 *
 * Five questions a factory actually asks: what did we make, what did it eat,
 * what did we buy, what failed, and what broke. Each is a separate call rather
 * than one enormous payload, because they are read on different screens by
 * different people and computing all five to show one is waste.
 *
 * All arithmetic is done here against the database. The AI assistant reads
 * these results rather than a list of rows (§25) — a language model asked to
 * total a column will sometimes get it wrong, and a wrong production figure is
 * indistinguishable from a right one to the person reading it.
 */

export const analyticsRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  productId: z.string().optional(),
  productionLineId: z.string().optional(),
  warehouseId: z.string().optional(),
});

export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

function window(range: AnalyticsRange) {
  const to = range.to ?? new Date();
  // Ninety days by default: long enough for a trend, short enough that a
  // factory's first look is not a full-table scan.
  const from = range.from ?? new Date(to.getTime() - 90 * 86_400_000);
  return { from, to };
}

export const manufacturingAnalytics = {
  /** What we made, how well, and where. */
  async production(range: AnalyticsRange = {}) {
    const organizationId = currentOrgId();
    const { from, to } = window(range);

    const orderWhere = {
      organizationId,
      deletedAt: null,
      actualCompletionDate: { gte: from, lte: to },
      ...(range.productId ? { productId: range.productId } : {}),
      ...(range.productionLineId ? { productionLineId: range.productionLineId } : {}),
    };

    const [totals, byProduct, byLine, variances] = await Promise.all([
      prisma.productionOrder.aggregate({
        where: orderWhere,
        _sum: { plannedQuantity: true, actualQuantity: true, rejectedQuantity: true },
        _count: true,
      }),
      prisma.productionOrder.groupBy({
        by: ['productId'],
        where: orderWhere,
        _sum: { plannedQuantity: true, actualQuantity: true, rejectedQuantity: true },
        _count: true,
      }),
      prisma.productionOrder.groupBy({
        by: ['productionLineId'],
        where: orderWhere,
        _sum: { plannedQuantity: true, actualQuantity: true, rejectedQuantity: true },
        _count: true,
      }),
      prisma.productionVariance.aggregate({
        where: { organizationId, calculatedAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
    ]);

    const exceeded = await prisma.productionVariance.count({
      where: { organizationId, calculatedAt: { gte: from, lte: to }, exceedsThreshold: true },
    });

    const products = await prisma.product.findMany({
      where: { id: { in: byProduct.map((r) => r.productId) } },
      select: { id: true, name: true, unit: true },
    });
    const lines = await prisma.productionLine.findMany({
      where: { id: { in: byLine.map((r) => r.productionLineId).filter(Boolean) as string[] } },
      select: { id: true, name: true, code: true },
    });

    const planned = Number(totals._sum.plannedQuantity ?? 0);
    const good = Number(totals._sum.actualQuantity ?? 0);
    const rejected = Number(totals._sum.rejectedQuantity ?? 0);

    return {
      period: { from, to },
      runs: totals._count,
      plannedQuantity: round3(planned),
      goodQuantity: round3(good),
      rejectedQuantity: round3(rejected),
      /** Good output against what was planned — the honest efficiency number. */
      efficiencyPercent: planned > 0 ? round2((good / planned) * 100) : null,
      /** The same figure a factory calls yield. */
      yieldPercent: planned > 0 ? round2((good / planned) * 100) : null,
      rejectionRatePercent: good + rejected > 0 ? round2((rejected / (good + rejected)) * 100) : null,
      materialVariance: {
        linesMeasured: variances._count._all,
        linesOverThreshold: exceeded,
        exceptionRatePercent:
          variances._count._all > 0 ? round2((exceeded / variances._count._all) * 100) : null,
      },
      byProduct: byProduct
        .map((row) => {
          const product = products.find((p) => p.id === row.productId);
          const p = Number(row._sum.plannedQuantity ?? 0);
          const g = Number(row._sum.actualQuantity ?? 0);
          return {
            productId: row.productId,
            name: product?.name ?? 'Unknown',
            unit: product?.unit ?? null,
            runs: row._count,
            plannedQuantity: round3(p),
            goodQuantity: round3(g),
            rejectedQuantity: round3(Number(row._sum.rejectedQuantity ?? 0)),
            yieldPercent: p > 0 ? round2((g / p) * 100) : null,
          };
        })
        .sort((a, b) => b.goodQuantity - a.goodQuantity),
      byProductionLine: byLine
        .filter((row) => row.productionLineId)
        .map((row) => {
          const line = lines.find((l) => l.id === row.productionLineId);
          const p = Number(row._sum.plannedQuantity ?? 0);
          const g = Number(row._sum.actualQuantity ?? 0);
          return {
            productionLineId: row.productionLineId,
            name: line?.name ?? 'Unknown',
            code: line?.code ?? null,
            runs: row._count,
            goodQuantity: round3(g),
            yieldPercent: p > 0 ? round2((g / p) * 100) : null,
          };
        })
        .sort((a, b) => b.goodQuantity - a.goodQuantity),
    };
  },

  /** What production ate, and what is left. */
  async inventory(range: AnalyticsRange = {}) {
    const organizationId = currentOrgId();
    const { from, to } = window(range);

    const consumption = await prisma.materialConsumption.groupBy({
      by: ['variantId'],
      where: {
        organizationId,
        occurredAt: { gte: from, lte: to },
        consumedQuantity: { gt: 0 },
      },
      _sum: { consumedQuantity: true, issuedQuantity: true },
    });

    const variants = await prisma.productVariant.findMany({
      where: { id: { in: consumption.map((c) => c.variantId) } },
      select: {
        id: true, sku: true, costPrice: true,
        product: { select: { id: true, name: true, unit: true, manufacturingType: true, standardCost: true } },
        stockLevels: { select: { quantity: true, reserved: true } },
      },
    });

    const usage = consumption
      .map((row) => {
        const variant = variants.find((v) => v.id === row.variantId);
        const consumed = Number(row._sum.consumedQuantity ?? 0);
        const unitCost =
          Number(variant?.costPrice ?? 0) || Number(variant?.product.standardCost ?? 0);
        const onHand =
          variant?.stockLevels.reduce((s, l) => s + Number(l.quantity) - Number(l.reserved), 0) ?? 0;
        return {
          variantId: row.variantId,
          sku: variant?.sku ?? null,
          name: variant?.product.name ?? 'Unknown',
          unit: variant?.product.unit ?? null,
          manufacturingType: variant?.product.manufacturingType ?? null,
          consumedQuantity: round3(consumed),
          issuedQuantity: round3(Number(row._sum.issuedQuantity ?? 0)),
          consumedValue: round2(consumed * unitCost),
          availableNow: round3(onHand),
          /*
           * How long the current stock lasts at this rate. The number a buyer
           * actually plans against — "800kg left" means nothing until you know
           * whether that is a week or an afternoon.
           */
          daysOfCoverRemaining:
            consumed > 0
              ? round2(onHand / (consumed / Math.max(1, daysBetween(from, to))))
              : null,
        };
      })
      .sort((a, b) => b.consumedValue - a.consumedValue);

    return {
      period: { from, to },
      materialsUsed: usage.length,
      totalConsumedValue: round2(usage.reduce((sum, u) => sum + u.consumedValue, 0)),
      usage,
      /** The ones that run out first at the current rate. */
      runningOutSoonest: usage
        .filter((u) => u.daysOfCoverRemaining !== null)
        .sort((a, b) => (a.daysOfCoverRemaining ?? 0) - (b.daysOfCoverRemaining ?? 0))
        .slice(0, 10),
    };
  },

  /** What we bought, and whether it arrived. */
  async procurement(range: AnalyticsRange = {}) {
    const organizationId = currentOrgId();
    const { from, to } = window(range);

    const orders = await prisma.purchaseOrder.findMany({
      where: { organizationId, createdAt: { gte: from, lte: to } },
      select: {
        id: true, number: true, status: true, total: true, currency: true,
        expectedAt: true, createdAt: true,
        supplier: { select: { id: true, name: true } },
        items: { select: { quantity: true, receivedQty: true } },
      },
    });

    const bySupplier = new Map<
      string,
      { name: string; orders: number; value: number; late: number; outstanding: number }
    >();
    let outstandingValue = 0;

    const now = new Date();
    for (const order of orders) {
      const entry = bySupplier.get(order.supplier.id) ?? {
        name: order.supplier.name,
        orders: 0,
        value: 0,
        late: 0,
        outstanding: 0,
      };
      entry.orders += 1;
      entry.value += Number(order.total);

      const open = ['ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status);
      if (open) {
        entry.outstanding += 1;
        outstandingValue += Number(order.total);
        // Late is only meaningful against a promised date; an order with none
        // is not late, it is unscheduled.
        if (order.expectedAt && order.expectedAt < now) entry.late += 1;
      }
      bySupplier.set(order.supplier.id, entry);
    }

    return {
      period: { from, to },
      ordersRaised: orders.length,
      totalValue: round2(orders.reduce((sum, o) => sum + Number(o.total), 0)),
      outstandingOrders: orders.filter((o) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status)).length,
      outstandingValue: round2(outstandingValue),
      overdueOrders: orders.filter(
        (o) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status) && o.expectedAt && o.expectedAt < now,
      ).length,
      bySupplier: [...bySupplier.entries()]
        .map(([id, s]) => ({
          supplierId: id,
          name: s.name,
          orders: s.orders,
          value: round2(s.value),
          outstanding: s.outstanding,
          overdue: s.late,
          /** Share of this supplier's orders that are past their promised date. */
          overdueRatePercent: s.orders > 0 ? round2((s.late / s.orders) * 100) : null,
        }))
        .sort((a, b) => b.value - a.value),
    };
  },

  /** What passed, what failed, and what is still held. */
  async quality(range: AnalyticsRange = {}) {
    const organizationId = currentOrgId();
    const { from, to } = window(range);

    const [inspections, batches, quarantines] = await Promise.all([
      prisma.qualityInspection.groupBy({
        by: ['status'],
        where: { organizationId, inspectedAt: { gte: from, lte: to } },
        _count: true,
      }),
      prisma.batch.groupBy({
        by: ['qcStatus'],
        where: { organizationId, productionDate: { gte: from, lte: to } },
        _count: true,
        _sum: { quantityProduced: true },
      }),
      prisma.quarantineRecord.groupBy({
        by: ['status'],
        where: { organizationId, heldAt: { gte: from, lte: to } },
        _count: true,
        _sum: { quantity: true },
      }),
    ]);

    const byStatus = Object.fromEntries(inspections.map((r) => [r.status, r._count]));
    const concluded = (byStatus.PASSED ?? 0) + (byStatus.FAILED ?? 0) + (byStatus.CONDITIONAL ?? 0);

    return {
      period: { from, to },
      inspections: {
        total: inspections.reduce((sum, r) => sum + r._count, 0),
        pending: byStatus.PENDING ?? 0,
        passed: byStatus.PASSED ?? 0,
        failed: byStatus.FAILED ?? 0,
        conditional: byStatus.CONDITIONAL ?? 0,
        /*
         * Out of concluded inspections only. Counting pending ones as neither
         * passed nor failed would make the rate fall simply because a backlog
         * built up.
         */
        failureRatePercent: concluded > 0 ? round2(((byStatus.FAILED ?? 0) / concluded) * 100) : null,
      },
      batches: batches.map((row) => ({
        qcStatus: row.qcStatus,
        count: row._count,
        quantity: round3(Number(row._sum.quantityProduced ?? 0)),
      })),
      quarantine: quarantines.map((row) => ({
        status: row.status,
        count: row._count,
        quantity: round3(Number(row._sum.quantity ?? 0)),
      })),
      currentlyHeld: await prisma.batch.count({ where: { organizationId, isQuarantined: true } }),
    };
  },

  /** What broke, for how long, and at what cost. */
  async maintenance(range: AnalyticsRange = {}) {
    const organizationId = currentOrgId();
    const { from, to } = window(range);

    const workOrders = await prisma.maintenanceWorkOrder.findMany({
      where: { organizationId, deletedAt: null, createdAt: { gte: from, lte: to } },
      select: {
        id: true, type: true, status: true, downtimeMinutes: true, cost: true,
        createdAt: true, completionDate: true,
        equipment: { select: { id: true, name: true, code: true } },
      },
    });

    const byEquipment = new Map<
      string,
      { name: string; code: string; jobs: number; breakdowns: number; downtime: number; cost: number }
    >();
    for (const wo of workOrders) {
      const entry = byEquipment.get(wo.equipment.id) ?? {
        name: wo.equipment.name,
        code: wo.equipment.code,
        jobs: 0,
        breakdowns: 0,
        downtime: 0,
        cost: 0,
      };
      entry.jobs += 1;
      // Preventive work is planned; only unplanned stoppages are breakdowns.
      if (wo.type !== 'PREVENTIVE') entry.breakdowns += 1;
      entry.downtime += wo.downtimeMinutes ?? 0;
      entry.cost += Number(wo.cost ?? 0);
      byEquipment.set(wo.equipment.id, entry);
    }

    const periodMinutes = Math.max(1, daysBetween(from, to) * 24 * 60);
    const totalDowntime = workOrders.reduce((sum, w) => sum + (w.downtimeMinutes ?? 0), 0);

    return {
      period: { from, to },
      workOrders: workOrders.length,
      completed: workOrders.filter((w) => w.status === 'COMPLETED').length,
      open: workOrders.filter((w) => ['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(w.status)).length,
      breakdowns: workOrders.filter((w) => w.type !== 'PREVENTIVE').length,
      preventive: workOrders.filter((w) => w.type === 'PREVENTIVE').length,
      totalDowntimeMinutes: totalDowntime,
      totalDowntimeHours: round2(totalDowntime / 60),
      totalCost: round2(workOrders.reduce((sum, w) => sum + Number(w.cost ?? 0), 0)),
      byEquipment: [...byEquipment.entries()]
        .map(([id, e]) => ({
          equipmentId: id,
          name: e.name,
          code: e.code,
          jobs: e.jobs,
          breakdowns: e.breakdowns,
          downtimeMinutes: e.downtime,
          downtimeHours: round2(e.downtime / 60),
          cost: round2(e.cost),
          /** Share of the period the machine was available. */
          availabilityPercent: round2(((periodMinutes - e.downtime) / periodMinutes) * 100),
        }))
        .sort((a, b) => b.downtimeMinutes - a.downtimeMinutes),
    };
  },
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const daysBetween = (from: Date, to: Date) =>
  Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
