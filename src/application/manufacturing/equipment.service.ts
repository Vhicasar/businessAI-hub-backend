import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { applyMovement } from './stock-ledger';
import { manufacturingAlerts } from './manufacturing-alerts.service';

/**
 * Equipment and its maintenance (§17, §18).
 *
 * Two things make this more than a register of machines:
 *
 *  - Fitting a spare part takes it out of stock. A maintenance system that
 *    records parts on the work order but not in inventory produces a store
 *    whose count is wrong by exactly the number of bearings fitted this month.
 *  - Completing a work order records downtime, which is the number every
 *    availability and breakdown report is built from.
 */

export const equipmentSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40).toUpperCase(),
  category: z.string().trim().max(80).nullable().optional(),
  productionLineId: z.string().min(1).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  manufacturer: z.string().trim().max(160).nullable().optional(),
  model: z.string().trim().max(160).nullable().optional(),
  serialNumber: z.string().trim().max(120).nullable().optional(),
  purchaseDate: z.coerce.date().nullable().optional(),
  warrantyExpiry: z.coerce.date().nullable().optional(),
  status: z.enum(['OPERATIONAL', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'RETIRED']).optional(),
  maintenanceFrequencyDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  lastMaintenanceAt: z.coerce.date().nullable().optional(),
  nextMaintenanceAt: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const updateEquipmentSchema = equipmentSchema.partial();

export const workOrderSchema = z.object({
  equipmentId: z.string().min(1),
  type: z.enum(['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY']).default('CORRECTIVE'),
  issue: z.string().trim().min(1).max(2000),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY']).default('MEDIUM'),
  assignedEmployeeId: z.string().min(1).nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const completeWorkOrderSchema = z.object({
  /** Minutes the machine was unavailable — the basis of every downtime report. */
  downtimeMinutes: z.coerce.number().int().min(0).max(1_000_000).optional(),
  cost: z.coerce.number().min(0).optional(),
  completionDate: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** Parts fitted. Each one leaves the store it came from. */
  parts: z
    .array(
      z.object({
        variantId: z.string().min(1),
        warehouseId: z.string().min(1),
        quantity: z.coerce.number().positive(),
        unitCost: z.coerce.number().min(0).nullable().optional(),
      }),
    )
    .optional(),
});

const equipmentSelect = {
  id: true, name: true, code: true, category: true, location: true,
  manufacturer: true, model: true, serialNumber: true,
  purchaseDate: true, warrantyExpiry: true, status: true,
  maintenanceFrequencyDays: true, lastMaintenanceAt: true, nextMaintenanceAt: true,
  notes: true, createdAt: true,
  productionLine: { select: { id: true, name: true, code: true } },
} as const;

const workOrderSelect = {
  id: true, workOrderNumber: true, type: true, issue: true, priority: true,
  assignedEmployeeId: true, startDate: true, completionDate: true, status: true,
  downtimeMinutes: true, cost: true, notes: true, createdAt: true,
  equipment: { select: { id: true, name: true, code: true, status: true } },
  parts: {
    select: {
      id: true, quantity: true, unitCost: true, issuedAt: true,
      variant: { select: { id: true, sku: true, product: { select: { name: true, unit: true } } } },
    },
  },
} as const;

export const equipmentService = {
  // ── Register ─────────────────────────────────────────────────────────────
  async list(dto: { status?: string; productionLineId?: string; dueOnly?: boolean } = {}) {
    return prisma.equipment.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.productionLineId ? { productionLineId: dto.productionLineId } : {}),
        // Due, or overdue — both are things somebody has to act on.
        ...(dto.dueOnly ? { nextMaintenanceAt: { not: null, lte: new Date() } } : {}),
      },
      select: { ...equipmentSelect, _count: { select: { workOrders: true } } },
      orderBy: [{ nextMaintenanceAt: 'asc' }, { name: 'asc' }],
    });
  },

  async get(id: string) {
    const equipment = await prisma.equipment.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...equipmentSelect,
        workOrders: {
          where: { deletedAt: null },
          select: workOrderSelect,
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!equipment) throw new NotFoundError('Equipment');
    return equipment;
  },

  async create(dto: z.infer<typeof equipmentSchema>) {
    const code = dto.code.trim().toUpperCase();
    const clash = await prisma.equipment.findFirst({
      where: { code, deletedAt: null },
      select: { name: true },
    });
    if (clash) throw new ConflictError(`The code "${code}" is already used by ${clash.name}.`);

    const equipment = await prisma.equipment.create({
      data: {
        organizationId: currentOrgId(),
        name: dto.name.trim(),
        code,
        category: dto.category ?? null,
        productionLineId: dto.productionLineId ?? null,
        location: dto.location ?? null,
        manufacturer: dto.manufacturer ?? null,
        model: dto.model ?? null,
        serialNumber: dto.serialNumber ?? null,
        purchaseDate: dto.purchaseDate ?? null,
        warrantyExpiry: dto.warrantyExpiry ?? null,
        status: dto.status ?? 'OPERATIONAL',
        maintenanceFrequencyDays: dto.maintenanceFrequencyDays ?? null,
        lastMaintenanceAt: dto.lastMaintenanceAt ?? null,
        // Worked out from the frequency when not given, so a machine with a
        // service interval is never quietly missing its next date.
        nextMaintenanceAt:
          dto.nextMaintenanceAt ??
          nextDue(dto.lastMaintenanceAt ?? null, dto.maintenanceFrequencyDays ?? null),
        notes: dto.notes ?? null,
      },
      select: equipmentSelect,
    });
    await auditService
      .record({
        action: 'equipment.created',
        entityType: 'EQUIPMENT',
        entityId: equipment.id,
        after: { name: equipment.name, code: equipment.code },
      })
      .catch(() => {});
    return equipment;
  },

  async update(id: string, dto: z.infer<typeof updateEquipmentSchema>) {
    const before = await prisma.equipment.findFirst({
      where: { id, deletedAt: null },
      select: equipmentSelect,
    });
    if (!before) throw new NotFoundError('Equipment');

    const equipment = await prisma.equipment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code.trim().toUpperCase() } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.productionLineId !== undefined ? { productionLineId: dto.productionLineId } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer } : {}),
        ...(dto.model !== undefined ? { model: dto.model } : {}),
        ...(dto.serialNumber !== undefined ? { serialNumber: dto.serialNumber } : {}),
        ...(dto.purchaseDate !== undefined ? { purchaseDate: dto.purchaseDate } : {}),
        ...(dto.warrantyExpiry !== undefined ? { warrantyExpiry: dto.warrantyExpiry } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.maintenanceFrequencyDays !== undefined
          ? { maintenanceFrequencyDays: dto.maintenanceFrequencyDays }
          : {}),
        ...(dto.lastMaintenanceAt !== undefined ? { lastMaintenanceAt: dto.lastMaintenanceAt } : {}),
        ...(dto.nextMaintenanceAt !== undefined ? { nextMaintenanceAt: dto.nextMaintenanceAt } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      select: equipmentSelect,
    });

    if (dto.status && dto.status !== before.status) {
      await auditService
        .record({
          action: 'equipment.status_changed',
          entityType: 'EQUIPMENT',
          entityId: id,
          before: { status: before.status },
          after: { status: dto.status },
        })
        .catch(() => {});
    }
    return equipment;
  },

  // ── Maintenance work orders ──────────────────────────────────────────────
  async listWorkOrders(dto: { status?: string; equipmentId?: string; limit?: number } = {}) {
    return prisma.maintenanceWorkOrder.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.equipmentId ? { equipmentId: dto.equipmentId } : {}),
      },
      select: workOrderSelect,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: dto.limit ?? 50,
    });
  },

  async getWorkOrder(id: string) {
    const wo = await prisma.maintenanceWorkOrder.findFirst({
      where: { id, deletedAt: null },
      select: workOrderSelect,
    });
    if (!wo) throw new NotFoundError('Work order');
    return wo;
  },

  /**
   * Raise a work order.
   *
   * An emergency one takes the machine out of service straight away — a
   * breakdown that is recorded but leaves the equipment marked operational is
   * how a run gets scheduled onto a machine that cannot run.
   */
  async createWorkOrder(dto: z.infer<typeof workOrderSchema>) {
    const equipment = await prisma.equipment.findFirst({
      where: { id: dto.equipmentId, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!equipment) throw new NotFoundError('Equipment');

    const workOrderNumber = await nextWorkOrderNumber();
    const wo = await prisma.$transaction(async (tx) => {
      const created = await tx.maintenanceWorkOrder.create({
        data: {
          organizationId: currentOrgId(),
          workOrderNumber,
          equipmentId: dto.equipmentId,
          type: dto.type,
          issue: dto.issue,
          priority: dto.priority,
          assignedEmployeeId: dto.assignedEmployeeId ?? null,
          startDate: dto.startDate ?? null,
          status: dto.assignedEmployeeId ? 'ASSIGNED' : 'OPEN',
          notes: dto.notes ?? null,
        },
        select: workOrderSelect,
      });
      if (dto.type === 'EMERGENCY' && equipment.status !== 'BREAKDOWN') {
        await tx.equipment.update({
          where: { id: dto.equipmentId },
          data: { status: 'BREAKDOWN' },
        });
      }
      return created;
    });

    if (dto.type === 'EMERGENCY') {
      await manufacturingAlerts
        .equipmentBreakdown(currentOrgId(), {
          equipmentId: dto.equipmentId,
          name: equipment.name,
          issue: dto.issue,
          workOrderNumber,
        })
        .catch(() => {});
    }

    await auditService
      .record({
        action: 'maintenance.work_order_raised',
        entityType: 'MAINTENANCE_WORK_ORDER',
        entityId: wo.id,
        after: {
          workOrderNumber, equipment: equipment.name,
          type: dto.type, priority: dto.priority,
        },
        reason: dto.issue,
      })
      .catch(() => {});
    return wo;
  },

  async assignWorkOrder(id: string, employeeId: string) {
    const wo = await prisma.maintenanceWorkOrder.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!wo) throw new NotFoundError('Work order');
    if (['COMPLETED', 'CANCELLED'].includes(wo.status)) {
      throw new ValidationError(`A ${wo.status.toLowerCase()} work order cannot be reassigned.`);
    }
    const updated = await prisma.maintenanceWorkOrder.update({
      where: { id },
      data: { assignedEmployeeId: employeeId, status: wo.status === 'OPEN' ? 'ASSIGNED' : wo.status },
      select: workOrderSelect,
    });
    await auditService
      .record({
        action: 'maintenance.work_order_assigned',
        entityType: 'MAINTENANCE_WORK_ORDER',
        entityId: id,
        after: { assignedEmployeeId: employeeId },
      })
      .catch(() => {});
    return updated;
  },

  async startWorkOrder(id: string) {
    const wo = await prisma.maintenanceWorkOrder.findFirst({
      where: { id, deletedAt: null },
      // The equipment's own status is read too: starting a work order takes a
      // machine off the line, and that is the half of this action an auditor
      // actually cares about.
      select: {
        id: true, status: true, equipmentId: true, workOrderNumber: true,
        equipment: { select: { name: true, code: true, status: true } },
      },
    });
    if (!wo) throw new NotFoundError('Work order');
    if (!['OPEN', 'ASSIGNED'].includes(wo.status)) {
      throw new ValidationError(`A ${wo.status.toLowerCase()} work order cannot be started.`);
    }
    const updated = await prisma.$transaction(async (tx) => {
      await tx.equipment.update({ where: { id: wo.equipmentId }, data: { status: 'MAINTENANCE' } });
      return tx.maintenanceWorkOrder.update({
        where: { id },
        data: { status: 'IN_PROGRESS', startDate: new Date() },
        select: workOrderSelect,
      });
    });
    await auditService
      .record({
        action: 'maintenance.work_order_started',
        entityType: 'MAINTENANCE_WORK_ORDER',
        entityId: id,
        before: {
          status: wo.status,
          equipmentStatus: wo.equipment?.status ?? null,
        },
        after: {
          workOrderNumber: wo.workOrderNumber,
          status: 'IN_PROGRESS',
          startDate: updated.startDate?.toISOString() ?? null,
          equipmentId: wo.equipmentId,
          equipmentName: wo.equipment?.name ?? null,
          equipmentCode: wo.equipment?.code ?? null,
          // The machine is now down for maintenance — the consequence of this
          // action, and not otherwise recoverable from the log.
          equipmentStatus: 'MAINTENANCE',
        },
      })
      .catch(() => {});
    return updated;
  },

  /**
   * Close a work order, taking the parts out of stock.
   *
   * Atomic with the parts (§32): if a spare part cannot be issued because the
   * store does not have it, the work order does not close either. Otherwise
   * the machine reads as fixed while inventory says the part was never used.
   */
  async completeWorkOrder(
    id: string,
    dto: z.infer<typeof completeWorkOrderSchema>,
    actorUserId: string,
  ) {
    const wo = await prisma.maintenanceWorkOrder.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, organizationId: true, status: true, workOrderNumber: true,
        equipmentId: true,
        equipment: { select: { name: true, maintenanceFrequencyDays: true } },
      },
    });
    if (!wo) throw new NotFoundError('Work order');
    if (wo.status === 'COMPLETED') throw new ValidationError('This work order is already completed.');
    if (wo.status === 'CANCELLED') throw new ValidationError('A cancelled work order cannot be completed.');

    const completedAt = dto.completionDate ?? new Date();
    let partsCost = 0;

    const updated = await prisma.$transaction(async (tx) => {
      for (const part of dto.parts ?? []) {
        // Out of the store it came from, with a movement of its own — a part
        // fitted is stock consumed like any other.
        await applyMovement(tx, {
          organizationId: wo.organizationId,
          warehouseId: part.warehouseId,
          variantId: part.variantId,
          quantityChange: -part.quantity,
          type: 'MAINTENANCE_CONSUMPTION',
          referenceType: 'MAINTENANCE_WORK_ORDER',
          referenceId: id,
          reason: `Fitted during ${wo.workOrderNumber}`,
          actorUserId,
        });
        await tx.maintenancePart.create({
          data: {
            organizationId: wo.organizationId,
            workOrderId: id,
            variantId: part.variantId,
            warehouseId: part.warehouseId,
            quantity: part.quantity,
            unitCost: part.unitCost ?? null,
            issuedAt: completedAt,
          },
        });
        partsCost += (part.unitCost ?? 0) * part.quantity;
      }

      // Back in service, and the next service date moved on.
      await tx.equipment.update({
        where: { id: wo.equipmentId },
        data: {
          status: 'OPERATIONAL',
          lastMaintenanceAt: completedAt,
          nextMaintenanceAt: nextDue(completedAt, wo.equipment.maintenanceFrequencyDays),
        },
      });

      return tx.maintenanceWorkOrder.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completionDate: completedAt,
          downtimeMinutes: dto.downtimeMinutes ?? null,
          // Labour and parts together, so "what did this cost" needs one read.
          cost: (dto.cost ?? 0) + partsCost,
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        select: workOrderSelect,
      });
    });

    await auditService
      .record({
        action: 'maintenance.work_order_completed',
        entityType: 'MAINTENANCE_WORK_ORDER',
        entityId: id,
        after: {
          equipment: wo.equipment.name,
          downtimeMinutes: dto.downtimeMinutes ?? null,
          partsFitted: dto.parts?.length ?? 0,
          totalCost: (dto.cost ?? 0) + partsCost,
        },
        reason: dto.notes ?? null,
      })
      .catch(() => {});
    return updated;
  },
};

/** The next service date, or null when the machine has no schedule. */
function nextDue(from: Date | null, frequencyDays: number | null): Date | null {
  if (!from || !frequencyDays) return null;
  return new Date(from.getTime() + frequencyDays * 86_400_000);
}

async function nextWorkOrderNumber(): Promise<string> {
  const count = await prisma.maintenanceWorkOrder.count();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `WO-${String(count + 1 + attempt).padStart(5, '0')}`;
    const clash = await prisma.maintenanceWorkOrder.findFirst({
      where: { workOrderNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError('Could not allocate a work order number.');
}
