import { z } from 'zod';
import type { Prisma } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { ZERO, money } from '../../shared/money';
import { notifyBusiness } from '../notifications/notify';
import { purchaseOrdersService } from './purchase-orders.service';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

export const reorderPolicySchema = z.object({
  isEnabled: z.boolean().optional(),
  createAs: z.enum(['DRAFT', 'ORDERED']).optional(),
  defaultReorderQty: z.coerce.number().positive().nullable().optional(),
  cooldownHours: z.coerce.number().int().min(1).max(720).optional(),
  skipUnsourced: z.boolean().optional(),
});

const DEFAULTS = {
  isEnabled: false,
  createAs: 'DRAFT',
  defaultReorderQty: null,
  cooldownHours: 24,
  skipUnsourced: true,
};

/** A line that has fallen to or below its reorder point. */
export interface ShortfallLine {
  variantId: string;
  sku: string;
  name: string;
  warehouseId: string;
  warehouseName: string;
  /** On hand minus what is already promised to customers. */
  available: string;
  reorderPoint: string;
  /** How many to buy: the level's own quantity, the supplier minimum, or the policy default. */
  suggestedQty: string;
  supplierId: string | null;
  supplierName: string | null;
  unitCost: string | null;
  supplierSku: string | null;
  /** Why nothing can be ordered, when that is the case. */
  blockedReason: string | null;
}

export const reorderService = {
  async getPolicy() {
    const organizationId = currentOrgId();
    const row = await prismaUnscoped.reorderPolicy.findUnique({ where: { organizationId } });
    return {
      ...DEFAULTS,
      ...(row
        ? {
            isEnabled: row.isEnabled,
            createAs: row.createAs,
            defaultReorderQty: row.defaultReorderQty?.toString() ?? null,
            cooldownHours: row.cooldownHours,
            skipUnsourced: row.skipUnsourced,
            lastRunAt: row.lastRunAt,
          }
        : { lastRunAt: null }),
    };
  },

  async setPolicy(dto: z.infer<typeof reorderPolicySchema>) {
    const organizationId = currentOrgId();
    const data = {
      ...(dto.isEnabled === undefined ? {} : { isEnabled: dto.isEnabled }),
      ...(dto.createAs === undefined ? {} : { createAs: dto.createAs }),
      ...(dto.defaultReorderQty === undefined ? {} : { defaultReorderQty: dto.defaultReorderQty }),
      ...(dto.cooldownHours === undefined ? {} : { cooldownHours: dto.cooldownHours }),
      ...(dto.skipUnsourced === undefined ? {} : { skipUnsourced: dto.skipUnsourced }),
    };
    await prismaUnscoped.reorderPolicy.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    return this.getPolicy();
  },

  /**
   * Everything currently at or below its reorder point.
   *
   * Measured on *available* stock — on hand minus what is already reserved for
   * customer orders — because stock promised to someone else cannot serve the
   * next customer, and a reorder point that ignores reservations reorders too
   * late to be any use.
   */
  async shortfalls(organizationId?: string): Promise<ShortfallLine[]> {
    const orgId = organizationId ?? currentOrgId();
    const policy = await prismaUnscoped.reorderPolicy.findUnique({ where: { organizationId: orgId } });
    const fallbackQty = policy?.defaultReorderQty ?? null;
    // What is already coming. Reported here as well as enforced during the run,
    // so the preview never promises an order the sweep will decline to raise.
    const onOrder = await this.openOrderNumbers(orgId, policy?.cooldownHours ?? DEFAULTS.cooldownHours);

    const levels = await prismaUnscoped.stockLevel.findMany({
      where: { organizationId: orgId, reorderPoint: { not: null } },
      include: {
        warehouse: { select: { id: true, name: true, deletedAt: true, isActive: true } },
        variant: {
          select: {
            id: true, sku: true, name: true, deletedAt: true,
            product: {
              select: {
                id: true, name: true, status: true, deletedAt: true,
                suppliers: {
                  where: { supplier: { deletedAt: null, isActive: true } },
                  orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
                  take: 1,
                  include: { supplier: { select: { id: true, name: true, currency: true } } },
                },
              },
            },
          },
        },
      },
    });

    const out: ShortfallLine[] = [];
    for (const level of levels) {
      if (level.variant.deletedAt || level.variant.product.deletedAt) continue;
      if (level.warehouse.deletedAt || !level.warehouse.isActive) continue;
      // An archived product is not being sold, so it does not need restocking.
      if (level.variant.product.status === 'ARCHIVED') continue;

      const available = money(level.quantity).sub(level.reserved);
      const point = money(level.reorderPoint!);
      if (available.greaterThan(point)) continue;

      const link = level.variant.product.suppliers[0];
      const minOrder = link?.minOrderQty ?? null;
      // Buy back up to the reorder point at minimum, then respect whichever
      // floor is higher: the level's own quantity, the supplier's minimum, or
      // the org default. Ordering less than the shortfall just triggers again.
      const shortfall = point.sub(available);
      const candidates = [level.reorderQty, minOrder, fallbackQty, shortfall]
        .filter((v): v is Prisma.Decimal => v !== null && v !== undefined)
        .map((v) => money(v));
      const suggested = candidates.reduce((a, b) => (b.greaterThan(a) ? b : a), money(shortfall));

      out.push({
        variantId: level.variantId,
        sku: level.variant.sku,
        name:
          level.variant.product.name +
          (level.variant.name && level.variant.name !== 'Default' ? ` — ${level.variant.name}` : ''),
        warehouseId: level.warehouseId,
        warehouseName: level.warehouse.name,
        available: available.toString(),
        reorderPoint: point.toString(),
        suggestedQty: suggested.toString(),
        supplierId: link?.supplierId ?? null,
        supplierName: link?.supplier.name ?? null,
        unitCost: link?.costPrice?.toFixed(2) ?? null,
        supplierSku: link?.supplierSku ?? null,
        blockedReason: onOrder.get(level.variantId)
          ? `Already on order (${onOrder.get(level.variantId)})`
          : link
            ? link.costPrice === null
              ? 'No cost price recorded for this supplier'
              : null
            : 'No supplier linked to this product',
      });
    }
    return out;
  },

  /**
   * Variants that already sit on an open order raised inside the cooldown,
   * mapped to the order that covers them.
   */
  async openOrderNumbers(organizationId: string, cooldownHours: number): Promise<Map<string, string>> {
    const since = new Date(Date.now() - cooldownHours * 3_600_000);
    const rows = await prismaUnscoped.purchaseOrderItem.findMany({
      where: {
        purchaseOrder: {
          organizationId,
          status: { in: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] },
          createdAt: { gte: since },
        },
      },
      select: { variantId: true, purchaseOrder: { select: { number: true } } },
    });
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.variantId, r.purchaseOrder.number);
    return map;
  },

  /**
   * Raise the orders those shortfalls call for, one per supplier/warehouse.
   *
   * Grouping matters: five items short from the same supplier is one purchase
   * order, not five, or the buyer drowns in paperwork and the supplier gets
   * five deliveries to make.
   */
  async run(
    organizationId: string,
    opts: { actorUserId?: string; force?: boolean } = {}
  ): Promise<{ created: string[]; skipped: ShortfallLine[]; reason?: string }> {
    const policy = await prismaUnscoped.reorderPolicy.findUnique({ where: { organizationId } });
    if (!opts.force && !policy?.isEnabled) {
      return { created: [], skipped: [], reason: 'Automatic reordering is turned off.' };
    }

    const lines = await this.shortfalls(organizationId);
    if (lines.length === 0) {
      await this.stampRun(organizationId);
      return { created: [], skipped: [] };
    }

    const skipped: ShortfallLine[] = [];
    const groups = new Map<string, { supplierId: string; warehouseId: string; lines: ShortfallLine[] }>();

    for (const line of lines) {
      // `shortfalls` already marks anything on a recent open order as blocked:
      // the stock is coming, and a second order would double the delivery.
      // That is a normal outcome, not something to report — only genuinely
      // stuck items make the "needs attention" list.
      if (line.blockedReason?.startsWith('Already on order')) continue;
      if (!line.supplierId || line.blockedReason) {
        skipped.push(line);
        continue;
      }
      const key = `${line.supplierId}:${line.warehouseId}`;
      const group = groups.get(key) ?? { supplierId: line.supplierId, warehouseId: line.warehouseId, lines: [] };
      group.lines.push(line);
      groups.set(key, group);
    }

    const created: string[] = [];
    for (const group of groups.values()) {
      try {
        const po = await requestContext.run({ organizationId, requestId: 'reorder' } as never, () =>
          purchaseOrdersService.create(
            {
              supplierId: group.supplierId,
              warehouseId: group.warehouseId,
              notes: 'Raised automatically — stock reached its reorder point.',
              items: group.lines.map((l) => ({
                variantId: l.variantId,
                quantity: Number(l.suggestedQty),
                unitCost: Number(l.unitCost ?? 0),
                taxRate: 0,
                supplierSku: l.supplierSku,
              })),
            },
            opts.actorUserId,
            { autoGenerated: true }
          )
        );
        created.push(po.number);

        if ((policy?.createAs ?? DEFAULTS.createAs) === 'ORDERED') {
          await requestContext.run({ organizationId, requestId: 'reorder' } as never, () =>
            purchaseOrdersService.place(po.id, opts.actorUserId)
          );
        }
      } catch (err) {
        // One bad supplier must not stop the rest of the sweep.
        logger.error({ err, organizationId, supplierId: group.supplierId }, 'auto reorder failed for supplier');
      }
    }

    await this.stampRun(organizationId);

    if (created.length > 0 || skipped.length > 0) {
      const draft = (policy?.createAs ?? DEFAULTS.createAs) === 'DRAFT';
      await notifyBusiness({
        organizationId,
        title:
          created.length > 0
            ? `${created.length} purchase order${created.length === 1 ? '' : 's'} raised for low stock`
            : 'Low stock needs your attention',
        body: [
          created.length > 0
            ? `${created.join(', ')} ${draft ? 'are waiting for your approval' : 'have been sent'}.`
            : null,
          // Naming the blocked items is the point: they are the ones nobody
          // will notice otherwise.
          skipped.length > 0
            ? `${skipped.length} item${skipped.length === 1 ? '' : 's'} could not be ordered — ${[
                ...new Set(skipped.map((s) => s.blockedReason)),
              ].join('; ')}.`
            : null,
        ]
          .filter(Boolean)
          .join(' '),
        link: '/purchase-orders',
        type: 'inventory.reorder',
      }).catch((err) => logger.warn({ err, organizationId }, 'reorder notification failed'));
    }

    return { created, skipped };
  },

  async stampRun(organizationId: string) {
    await prismaUnscoped.reorderPolicy.upsert({
      where: { organizationId },
      create: { organizationId, lastRunAt: new Date() },
      update: { lastRunAt: new Date() },
    });
  },

  /** Set the reorder point and quantity on one stock line. */
  async setReorderLevel(
    stockLevelId: string,
    dto: { reorderPoint: number | null; reorderQty: number | null }
  ) {
    const level = await prisma.stockLevel.findFirst({ where: { id: stockLevelId } });
    if (!level) throw new ValidationError('That stock line does not exist');
    const updated = await prisma.stockLevel.update({
      where: { id: stockLevelId },
      data: { reorderPoint: dto.reorderPoint, reorderQty: dto.reorderQty },
    });
    return {
      id: updated.id,
      reorderPoint: updated.reorderPoint?.toString() ?? null,
      reorderQty: updated.reorderQty?.toString() ?? null,
    };
  },

  /** Every organization that opted in — what the sweep iterates. */
  async enabledOrganizations(): Promise<string[]> {
    const rows = await prismaUnscoped.reorderPolicy.findMany({
      where: { isEnabled: true },
      select: { organizationId: true },
    });
    return rows.map((r) => r.organizationId);
  },
};

let timer: NodeJS.Timeout | null = null;

/**
 * Periodic sweep for businesses with automatic reordering on.
 *
 * Polling rather than reacting to every stock movement: a busy shop moves stock
 * constantly, and reacting to each one would either raise duplicate orders or
 * need the same cooldown bookkeeping anyway. Hourly is well inside any
 * realistic supplier lead time.
 */
export function startReorderWatcher(intervalMs = 60 * 60_000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const orgIds = await reorderService.enabledOrganizations();
      for (const organizationId of orgIds) {
        try {
          const res = await reorderService.run(organizationId);
          if (res.created.length > 0) {
            logger.info({ organizationId, created: res.created }, 'auto reorder raised purchase orders');
          }
        } catch (err) {
          logger.error({ err, organizationId }, 'auto reorder tick failed for organization');
        }
      }
    } catch (err) {
      logger.error({ err }, 'reorder watcher tick failed');
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`📦 Reorder watcher started (${intervalMs}ms interval)`);
}
