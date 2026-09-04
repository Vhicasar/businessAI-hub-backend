import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { notifyService } from '../notifications/notify.service';
import { permissionsForRole } from '../roles/role-permissions';

/**
 * Manufacturing alerts (§27).
 *
 * Everything here goes through the notification system the product already
 * has, so these land in the same tray, obey the same preferences and are
 * marked read the same way as everything else.
 *
 * Two rules shape who gets told:
 *
 *  - By permission, not by role name. A business that renamed "Production
 *    Manager" or built its own role still gets its alerts, because the
 *    question asked is "who may act on this", not "who has this job title".
 *  - Nobody gets an alert they could not act on. Telling a cashier that a
 *    batch failed quality is noise they cannot clear, and noise is how people
 *    learn to ignore the tray.
 */

interface Alert {
  type: string;
  title: string;
  body: string;
  /** Anyone holding one of these is told. */
  permissions: string[];
  data?: Record<string, unknown>;
}

async function recipients(organizationId: string, permissions: string[]): Promise<string[]> {
  const memberships = await prismaUnscoped.membership.findMany({
    where: { organizationId, isActive: true, deletedAt: null },
    select: { userId: true, roleId: true },
  });

  const allowed: string[] = [];
  const cache = new Map<string, Set<string>>();
  for (const membership of memberships) {
    if (!membership.roleId) continue;
    let granted = cache.get(membership.roleId);
    if (!granted) {
      granted = await permissionsForRole(membership.roleId);
      cache.set(membership.roleId, granted);
    }
    if (permissions.some((p) => granted!.has(p))) allowed.push(membership.userId);
  }
  return allowed;
}

async function send(organizationId: string, alert: Alert): Promise<number> {
  const users = await recipients(organizationId, alert.permissions);
  if (users.length === 0) {
    // Worth a log rather than silence: an alert nobody can receive usually
    // means a permission was never granted to anyone.
    logger.warn(
      { organizationId, type: alert.type, permissions: alert.permissions },
      'manufacturing alert has no recipients',
    );
    return 0;
  }
  await notifyService.notifyUsers(organizationId, users, {
    type: alert.type,
    title: alert.title,
    body: alert.body,
    data: alert.data,
  });
  return users.length;
}

export const manufacturingAlerts = {
  /** A batch failed inspection. */
  async batchFailedQc(organizationId: string, input: {
    batchNumber: string; product: string; reason: string; batchId: string;
  }) {
    return send(organizationId, {
      type: 'manufacturing.batch_failed_qc',
      title: `Batch ${input.batchNumber} failed quality control`,
      body: `${input.product}: ${input.reason}. The stock is held and cannot be sold.`,
      permissions: ['qc.read', 'production.read', 'manufacturing.read'],
      data: { batchId: input.batchId, batchNumber: input.batchNumber },
    });
  },

  /** Stock has been quarantined. */
  async batchQuarantined(organizationId: string, input: {
    batchNumber: string; quantity: number; reason: string; batchId: string;
  }) {
    return send(organizationId, {
      type: 'manufacturing.batch_quarantined',
      title: `${input.quantity.toLocaleString()} units held: batch ${input.batchNumber}`,
      body: `${input.reason}. Held stock cannot be sold or transferred until it is released.`,
      permissions: ['qc.release', 'qc.read'],
      data: { batchId: input.batchId },
    });
  },

  /** A material is at or below the level the business set. */
  async materialLow(organizationId: string, input: {
    productId: string; name: string; available: number; floor: number; unit: string | null;
  }) {
    const unit = input.unit ? ` ${input.unit}` : '';
    return send(organizationId, {
      type: 'manufacturing.material_low',
      title: `${input.name} is at its stock floor`,
      body:
        `${input.available.toLocaleString()}${unit} left against a floor of ` +
        `${input.floor.toLocaleString()}${unit}. Order or transfer before the next run.`,
      // Buyers and planners both need this; only one of them can act on it.
      permissions: ['purchasing.create', 'production.plan', 'inventory.read'],
      data: { productId: input.productId },
    });
  },

  /** A production run cannot start because material is short. */
  async materialShortage(organizationId: string, input: {
    productionOrderId: string; orderNumber: string; shortages: string[];
  }) {
    return send(organizationId, {
      type: 'manufacturing.material_shortage',
      title: `${input.orderNumber} is short of materials`,
      body: `Short of ${input.shortages.join(', ')}. Buy or transfer before this run can proceed.`,
      permissions: ['production.plan', 'purchasing.create'],
      data: { productionOrderId: input.productionOrderId },
    });
  },

  /** A run has passed its expected completion date. */
  async productionDelayed(organizationId: string, input: {
    productionOrderId: string; orderNumber: string; product: string; daysLate: number;
  }) {
    return send(organizationId, {
      type: 'manufacturing.production_delayed',
      title: `${input.orderNumber} is ${input.daysLate} day${input.daysLate === 1 ? '' : 's'} late`,
      body: `${input.product} was due to finish and has not. Check the line and the materials.`,
      permissions: ['production.read'],
      data: { productionOrderId: input.productionOrderId },
    });
  },

  /** A machine is due, or overdue, for service. */
  async maintenanceDue(organizationId: string, input: {
    equipmentId: string; name: string; dueAt: Date; overdueDays: number;
  }) {
    return send(organizationId, {
      type: 'manufacturing.maintenance_due',
      title:
        input.overdueDays > 0
          ? `${input.name} is ${input.overdueDays} day${input.overdueDays === 1 ? '' : 's'} overdue for service`
          : `${input.name} is due for service`,
      body: 'Schedule it before it becomes a breakdown.',
      permissions: ['maintenance.create', 'maintenance.read'],
      data: { equipmentId: input.equipmentId },
    });
  },

  /** A machine has broken down. */
  async equipmentBreakdown(organizationId: string, input: {
    equipmentId: string; name: string; issue: string; workOrderNumber: string;
  }) {
    return send(organizationId, {
      type: 'manufacturing.equipment_breakdown',
      title: `${input.name} has broken down`,
      body: `${input.issue} (${input.workOrderNumber}). Production on this line is stopped.`,
      permissions: ['maintenance.read', 'production.read'],
      data: { equipmentId: input.equipmentId },
    });
  },

  /** A material drifted further from the recipe than the business tolerates. */
  async varianceExceeded(organizationId: string, input: {
    productionOrderId: string; orderNumber: string; material: string; variancePercent: number;
  }) {
    return send(organizationId, {
      type: 'manufacturing.variance_exceeded',
      title: `${input.material} used ${input.variancePercent}% above the recipe`,
      body: `On ${input.orderNumber}. Worth checking the line, the scales or the recipe itself.`,
      permissions: ['production.read', 'manufacturing.read'],
      data: { productionOrderId: input.productionOrderId },
    });
  },

  /**
   * The sweep: everything that is true right now rather than event-driven.
   *
   * Low stock, overdue runs and due services are states, not moments — nothing
   * happens at the instant a machine becomes overdue. So they are found by
   * looking, on whatever schedule the business runs this on.
   */
  async runSweep(organizationId: string): Promise<{ sent: number; alerts: string[] }> {
    const now = new Date();
    const sentTypes: string[] = [];
    let sent = 0;

    // ── Runs past their date ───────────────────────────────────────────────
    const late = await prismaUnscoped.productionOrder.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED'] },
        expectedCompletionDate: { lt: now },
      },
      select: {
        id: true, orderNumber: true, expectedCompletionDate: true,
        product: { select: { name: true } },
      },
      take: 25,
    });
    for (const order of late) {
      const days = Math.ceil((now.getTime() - order.expectedCompletionDate!.getTime()) / 86_400_000);
      sent += await this.productionDelayed(organizationId, {
        productionOrderId: order.id,
        orderNumber: order.orderNumber,
        product: order.product.name,
        daysLate: days,
      });
      sentTypes.push('production_delayed');
    }

    // ── Machines due for service ───────────────────────────────────────────
    const due = await prismaUnscoped.equipment.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { not: 'RETIRED' },
        nextMaintenanceAt: { not: null, lte: now },
      },
      select: { id: true, name: true, nextMaintenanceAt: true },
      take: 25,
    });
    for (const machine of due) {
      const overdue = Math.max(
        0,
        Math.floor((now.getTime() - machine.nextMaintenanceAt!.getTime()) / 86_400_000),
      );
      sent += await this.maintenanceDue(organizationId, {
        equipmentId: machine.id,
        name: machine.name,
        dueAt: machine.nextMaintenanceAt!,
        overdueDays: overdue,
      });
      sentTypes.push('maintenance_due');
    }

    return { sent, alerts: [...new Set(sentTypes)] };
  },
};
