import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { callerHasPermission } from '../roles/role-permissions';

/**
 * Production lines (§16) — the places production actually happens.
 *
 * A line's status is not decoration. A run cannot be started on a line that is
 * broken down or offline, which is the difference between recording that a
 * machine is down and the system acting on it.
 */

export const productionLineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  location: z.string().trim().max(200).nullable().optional(),
  capacity: z.coerce.number().positive().nullable().optional(),
  capacityUnit: z.string().trim().max(24).nullable().optional(),
  status: z.enum(['OPERATIONAL', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'OFFLINE']).optional(),
  responsibleEmployeeId: z.string().min(1).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const updateProductionLineSchema = productionLineSchema.partial();

const lineSelect = {
  id: true, name: true, code: true, location: true, capacity: true, capacityUnit: true,
  status: true, responsibleEmployeeId: true, description: true, createdAt: true,
} as const;

/** Statuses on which a production run may begin. */
export const RUNNABLE_LINE_STATUSES = ['OPERATIONAL', 'IDLE'] as const;

export const productionLinesService = {
  async list(dto: { status?: string; includeInactive?: boolean } = {}) {
    return prisma.productionLine.findMany({
      where: { deletedAt: null, ...(dto.status ? { status: dto.status as never } : {}) },
      select: {
        ...lineSelect,
        _count: { select: { equipment: true, productionOrders: true } },
      },
      orderBy: { name: 'asc' },
    });
  },

  async get(id: string) {
    const line = await prisma.productionLine.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...lineSelect,
        equipment: {
          where: { deletedAt: null },
          select: { id: true, name: true, code: true, status: true, nextMaintenanceAt: true },
        },
        productionOrders: {
          where: { status: { in: ['APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED'] } },
          select: { id: true, orderNumber: true, status: true, plannedQuantity: true },
        },
      },
    });
    if (!line) throw new NotFoundError('Production line');
    return line;
  },

  async create(dto: z.infer<typeof productionLineSchema>) {
    const code = dto.code.trim().toUpperCase();
    const clash = await prisma.productionLine.findFirst({
      where: { code, deletedAt: null },
      select: { name: true },
    });
    if (clash) throw new ConflictError(`The code "${code}" is already used by ${clash.name}.`);

    const line = await prisma.productionLine.create({
      data: {
        organizationId: currentOrgId(),
        name: dto.name.trim(),
        code,
        location: dto.location ?? null,
        capacity: dto.capacity ?? null,
        capacityUnit: dto.capacityUnit ?? null,
        status: dto.status ?? 'OPERATIONAL',
        responsibleEmployeeId: dto.responsibleEmployeeId ?? null,
        description: dto.description ?? null,
      },
      select: lineSelect,
    });
    await auditService
      .record({
        action: 'production_line.created',
        entityType: 'PRODUCTION_LINE',
        entityId: line.id,
        after: { name: line.name, code: line.code },
      })
      .catch(() => {});
    return line;
  },

  async update(id: string, dto: z.infer<typeof updateProductionLineSchema>) {
    const before = await prisma.productionLine.findFirst({
      where: { id, deletedAt: null },
      select: lineSelect,
    });
    if (!before) throw new NotFoundError('Production line');

    /*
     * A supervisor who can start runs may say a line has stopped, but may not
     * reconfigure the factory. The route guard is ANY-of and cannot express
     * that difference, so it is drawn here: without the settings permission,
     * `status` is the only field that may move.
     */
    if (!(await callerHasPermission('manufacturing.manage_settings'))) {
      const { status: _status, ...rest } = dto;
      const configured = Object.entries(rest).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (configured.length > 0) {
        throw new ForbiddenError(
          `You can change this line's status, but not ${configured.join(', ')}.`,
        );
      }
    }

    if (dto.code && dto.code.toUpperCase() !== before.code) {
      const clash = await prisma.productionLine.findFirst({
        where: { code: dto.code.toUpperCase(), deletedAt: null, id: { not: id } },
        select: { name: true },
      });
      if (clash) throw new ConflictError(`The code is already used by ${clash.name}.`);
    }

    const line = await prisma.productionLine.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code.trim().toUpperCase() } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.capacityUnit !== undefined ? { capacityUnit: dto.capacityUnit } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.responsibleEmployeeId !== undefined ? { responsibleEmployeeId: dto.responsibleEmployeeId } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
      },
      select: lineSelect,
    });

    // Worth its own audit action: a line going down is what explains a run
    // that stopped, and it should be findable without reading every update.
    if (dto.status && dto.status !== before.status) {
      await auditService
        .record({
          action: 'production_line.status_changed',
          entityType: 'PRODUCTION_LINE',
          entityId: id,
          before: { status: before.status },
          after: { status: dto.status },
        })
        .catch(() => {});
    }
    return line;
  },

  /**
   * Whether a run may start here.
   *
   * Reported rather than assumed, so the caller can say which line and why —
   * "Line 2 is under maintenance" is actionable, "cannot start" is not.
   */
  async assertRunnable(id: string): Promise<void> {
    const line = await prisma.productionLine.findFirst({
      where: { id, deletedAt: null },
      select: { name: true, status: true },
    });
    if (!line) throw new NotFoundError('Production line');
    if (!(RUNNABLE_LINE_STATUSES as readonly string[]).includes(line.status)) {
      throw new ValidationError(
        `${line.name} is ${line.status.toLowerCase().replace('_', ' ')}, so production cannot start on it.`,
      );
    }
  },

  async archive(id: string) {
    const line = await prisma.productionLine.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        _count: {
          select: {
            productionOrders: true,
            equipment: true,
          },
        },
      },
    });
    if (!line) throw new NotFoundError('Production line');

    // Kept when anything points at it, so past runs stay explicable.
    const used = line._count.productionOrders > 0 || line._count.equipment > 0;
    await prisma.productionLine.update({
      where: { id },
      data: used ? { status: 'OFFLINE' } : { status: 'OFFLINE', deletedAt: new Date() },
    });
    await auditService
      .record({
        action: 'production_line.retired',
        entityType: 'PRODUCTION_LINE',
        entityId: id,
        after: { removed: !used },
      })
      .catch(() => {});
    return { removed: !used };
  },
};
