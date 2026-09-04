import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { notifyBusiness } from '../notifications/notify';
import { logger } from '../../shared/logger';

/**
 * Warns a business before stock expires.
 *
 * Batches are recorded as stock movements carrying a batch number and an
 * expiry date, so the sweep reads those rather than a separate table. Each
 * product sets its own warning window (`expiryAlertDays`), because thirty days'
 * notice is generous for rice and far too late for a vaccine.
 *
 * Recipients are the people who can actually act: owners and admins, plus the
 * members assigned to the warehouse the stock is sitting in and that
 * warehouse's named manager. A warehouse manager confined to two sites is not
 * told about a third site's problem, and — more importantly — nobody's expiring
 * stock goes unmentioned because the only recipient was an owner who never
 * opens the app.
 */

/** One alert per batch line per window, so a nightly sweep is not a nightly spam. */
const ALERT_TYPE = 'inventory.expiring';

export interface ExpiringBatch {
  movementId: string;
  batchNumber: string;
  expiryDate: Date;
  daysToExpiry: number;
  quantity: number;
  sku: string;
  productName: string;
  unit: string | null;
  warehouseId: string;
  warehouseName: string;
}

/** Batches at or inside their product's own warning window. */
export async function findExpiring(organizationId: string): Promise<ExpiringBatch[]> {
  const now = new Date();
  // A generous outer bound keeps the query cheap; the per-product window is
  // applied in memory, where each product's own setting is available.
  const horizon = new Date(now.getTime() + 3650 * 86_400_000);

  const rows = await prismaUnscoped.stockMovement.findMany({
    where: {
      organizationId,
      batchNumber: { not: null },
      expiryDate: { not: null, lte: horizon },
      quantity: { gt: 0 },
    },
    select: {
      id: true,
      batchNumber: true,
      expiryDate: true,
      quantity: true,
      warehouseId: true,
      warehouse: { select: { id: true, name: true } },
      variant: {
        select: {
          sku: true,
          name: true,
          product: {
            select: { name: true, unit: true, expiryTracked: true, expiryAlertDays: true },
          },
        },
      },
    },
    orderBy: { expiryDate: 'asc' },
    take: 2000,
  });

  const out: ExpiringBatch[] = [];
  for (const r of rows) {
    if (!r.expiryDate || !r.batchNumber || !r.warehouseId || !r.warehouse) continue;
    const product = r.variant?.product;
    if (!product?.expiryTracked) continue;
    const days = Math.ceil((r.expiryDate.getTime() - now.getTime()) / 86_400_000);
    if (days > product.expiryAlertDays) continue;
    out.push({
      movementId: r.id,
      batchNumber: r.batchNumber,
      expiryDate: r.expiryDate,
      daysToExpiry: days,
      quantity: Number(r.quantity),
      sku: r.variant?.sku ?? '',
      productName: r.variant?.name || product.name,
      unit: product.unit,
      warehouseId: r.warehouseId,
      warehouseName: r.warehouse.name,
    });
  }
  return out;
}

/**
 * Everyone who should hear about stock in these warehouses: owners and admins
 * always, plus anyone assigned to (or managing) one of the warehouses named.
 */
async function recipientsFor(organizationId: string, warehouseIds: string[]): Promise<string[]> {
  const [admins, assigned, managed] = await Promise.all([
    prismaUnscoped.membership.findMany({
      where: {
        organizationId,
        isActive: true,
        deletedAt: null,
        OR: [{ isOwner: true }, { role: { name: { in: ['Owner', 'Admin', 'Administrator'] } } }],
      },
      select: { userId: true },
    }),
    prismaUnscoped.warehouseAssignment.findMany({
      where: { organizationId, warehouseId: { in: warehouseIds } },
      select: { membership: { select: { userId: true, isActive: true, deletedAt: true } } },
    }),
    prismaUnscoped.warehouse.findMany({
      where: { organizationId, id: { in: warehouseIds }, managerId: { not: null } },
      select: { managerId: true },
    }),
  ]);

  const ids = new Set(admins.map((m) => m.userId));
  for (const a of assigned) {
    if (a.membership && a.membership.isActive && !a.membership.deletedAt) {
      ids.add(a.membership.userId);
    }
  }

  // managerId is a membership id, not a user id — resolve it.
  const managerMembershipIds = managed.map((w) => w.managerId).filter((v): v is string => !!v);
  if (managerMembershipIds.length) {
    const managers = await prismaUnscoped.membership.findMany({
      where: { id: { in: managerMembershipIds }, isActive: true, deletedAt: null },
      select: { userId: true },
    });
    for (const m of managers) ids.add(m.userId);
  }

  return [...ids];
}

/**
 * Runs the sweep for one organization.
 *
 * Grouped per warehouse so each recipient gets one message about their own
 * site rather than a list spanning warehouses they cannot touch.
 */
export async function runExpirySweep(organizationId: string): Promise<{ alerted: number }> {
  const expiring = await findExpiring(organizationId);
  if (expiring.length === 0) return { alerted: 0 };

  const byWarehouse = new Map<string, ExpiringBatch[]>();
  for (const b of expiring) {
    const list = byWarehouse.get(b.warehouseId) ?? [];
    list.push(b);
    byWarehouse.set(b.warehouseId, list);
  }

  let alerted = 0;
  for (const [warehouseId, batches] of byWarehouse) {
    const userIds = await recipientsFor(organizationId, [warehouseId]);
    if (userIds.length === 0) continue;

    const expired = batches.filter((b) => b.daysToExpiry < 0);
    const soon = batches.filter((b) => b.daysToExpiry >= 0);
    const soonest = batches[0]!;
    const name = soonest.warehouseName;

    // Naming the soonest item makes the alert actionable at a glance; the
    // count carries the rest.
    const headline =
      expired.length > 0
        ? `${expired.length} batch${expired.length === 1 ? '' : 'es'} expired at ${name}`
        : `${soon.length} batch${soon.length === 1 ? '' : 'es'} expiring soon at ${name}`;

    const lead = soonest.daysToExpiry < 0
      ? `${soonest.productName} (batch ${soonest.batchNumber}) expired ${Math.abs(soonest.daysToExpiry)} day${Math.abs(soonest.daysToExpiry) === 1 ? '' : 's'} ago.`
      : `${soonest.productName} (batch ${soonest.batchNumber}) expires in ${soonest.daysToExpiry} day${soonest.daysToExpiry === 1 ? '' : 's'}.`;

    await notifyBusiness({
      organizationId,
      userIds,
      title: headline,
      body: `${lead} ${batches.length} batch${batches.length === 1 ? '' : 'es'} need attention.`,
      link: `/inventory?tab=batches&warehouseId=${warehouseId}`,
      type: ALERT_TYPE,
    }).catch((err) => logger.warn({ err, organizationId, warehouseId }, 'expiry alert failed'));
    alerted += batches.length;
  }

  return { alerted };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Daily sweep. Expiry moves at the pace of a calendar, so checking more often
 * would only repeat yesterday's message.
 */
export function startExpiryWatcher(intervalMs = 24 * 60 * 60_000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const orgs = await prismaUnscoped.organization.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      for (const { id } of orgs) {
        try {
          const res = await runExpirySweep(id);
          if (res.alerted > 0) {
            logger.info({ organizationId: id, alerted: res.alerted }, 'expiry alerts sent');
          }
        } catch (err) {
          logger.error({ err, organizationId: id }, 'expiry sweep failed for organization');
        }
      }
    } catch (err) {
      logger.error({ err }, 'expiry watcher tick failed');
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`🗓️  Expiry watcher started (${intervalMs}ms interval)`);
}
