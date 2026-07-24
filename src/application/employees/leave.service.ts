import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

/** Working days between two dates, inclusive, excluding weekends. */
export function workingDays(start: Date, end: Date): number {
  const a = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const b = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  if (b < a) return 0;
  let days = 0;
  for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
  }
  return days;
}

export const leaveTypeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  daysPerYear: z.coerce.number().min(0).max(365).default(0),
  isPaid: z.boolean().default(true),
  requiresApproval: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
export const createLeaveRequestSchema = z.object({
  employeeId: z.string().min(1),
  leaveTypeId: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.string().trim().max(1000).nullable().optional(),
});
export const decideLeaveSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  decisionNote: z.string().trim().max(500).optional(),
});
export const listLeaveSchema = z.object({
  status: z.enum(STATUSES).optional(),
  employeeId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const requestSelect = {
  id: true, startDate: true, endDate: true, days: true, reason: true, status: true,
  approverId: true, decidedAt: true, decisionNote: true, createdAt: true,
  employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
  leaveType: { select: { id: true, name: true, code: true, isPaid: true } },
} as const;

export const leaveService = {
  // ------------------------------------------------------------ leave types
  async listTypes() {
    return prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  },
  async createType(dto: z.infer<typeof leaveTypeSchema>) {
    const dup = await prisma.leaveType.findFirst({ where: { code: dto.code } });
    if (dup) throw new ConflictError(`A leave type with code "${dto.code}" already exists`);
    return prisma.leaveType.create({ data: { organizationId: orgId(), ...dto } });
  },
  async updateType(id: string, dto: z.infer<typeof leaveTypeSchema>) {
    const existing = await prisma.leaveType.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Leave type');
    return prisma.leaveType.update({ where: { id }, data: dto });
  },
  async deleteType(id: string) {
    const inUse = await prisma.leaveRequest.count({ where: { leaveTypeId: id } });
    if (inUse > 0) throw new ConflictError('Leave type has requests — deactivate it instead');
    await prisma.leaveType.deleteMany({ where: { id } });
    return { deleted: true };
  },

  // --------------------------------------------------------------- balances
  /** Balance for an employee/type/year, created from the type's entitlement on first use. */
  async ensureBalance(employeeId: string, leaveTypeId: string, year: number) {
    const existing = await prisma.leaveBalance.findFirst({ where: { employeeId, leaveTypeId, year } });
    if (existing) return existing;
    const type = await prisma.leaveType.findFirst({ where: { id: leaveTypeId } });
    if (!type) throw new NotFoundError('Leave type');
    return prisma.leaveBalance.create({
      data: { organizationId: orgId(), employeeId, leaveTypeId, year, entitledDays: type.daysPerYear },
    });
  },

  async balances(employeeId: string, year = new Date().getFullYear()) {
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null } });
    if (!employee) throw new NotFoundError('Employee');
    const types = await this.listTypes();
    const rows = await Promise.all(types.map((t) => this.ensureBalance(employeeId, t.id, year)));
    return rows.map((b) => {
      const type = types.find((t) => t.id === b.leaveTypeId)!;
      const available = b.entitledDays + b.carriedOverDays - b.usedDays;
      return {
        leaveTypeId: b.leaveTypeId,
        name: type.name,
        code: type.code,
        year,
        entitledDays: b.entitledDays,
        carriedOverDays: b.carriedOverDays,
        usedDays: b.usedDays,
        availableDays: Math.round(available * 100) / 100,
      };
    });
  },

  // --------------------------------------------------------------- requests
  async list(dto: z.infer<typeof listLeaveSchema>) {
    const rows = await prisma.leaveRequest.findMany({
      where: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.employeeId ? { employeeId: dto.employeeId } : {}),
      },
      select: requestSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async create(dto: z.infer<typeof createLeaveRequestSchema>) {
    const [employee, type] = await Promise.all([
      prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } }),
      prisma.leaveType.findFirst({ where: { id: dto.leaveTypeId, isActive: true } }),
    ]);
    if (!employee) throw new NotFoundError('Employee');
    if (!type) throw new NotFoundError('Leave type');
    if (dto.endDate < dto.startDate) throw new ValidationError('End date cannot be before start date');

    const days = workingDays(dto.startDate, dto.endDate);
    if (days <= 0) throw new ValidationError('The selected range contains no working days');

    // Overlapping active requests would double-book the same days.
    const overlap = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: dto.employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: dto.endDate },
        endDate: { gte: dto.startDate },
      },
    });
    if (overlap) throw new ConflictError('This employee already has leave booked in that range');

    const year = dto.startDate.getUTCFullYear();
    const balance = await this.ensureBalance(dto.employeeId, dto.leaveTypeId, year);
    const available = balance.entitledDays + balance.carriedOverDays - balance.usedDays;
    if (days > available) {
      throw new ValidationError(`Only ${available} day(s) of ${type.name} remain — ${days} requested`);
    }

    // Types that don't need approval are granted immediately (and deduct now).
    const autoApprove = !type.requiresApproval;
    const request = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId(),
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        days,
        reason: dto.reason ?? null,
        status: autoApprove ? 'APPROVED' : 'PENDING',
        ...(autoApprove ? { approverId: actorMembershipId(), decidedAt: new Date() } : {}),
      },
      select: requestSelect,
    });
    if (autoApprove) {
      await prisma.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: { increment: days } } });
    }
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'EMPLOYEE',
      entityId: dto.employeeId,
      title: `Leave ${autoApprove ? 'booked' : 'requested'} — ${type.name} (${days}d)`,
      body: `${dto.startDate.toDateString()} → ${dto.endDate.toDateString()}`,
    });
    return request;
  },

  /** Approve or reject. Approval deducts the balance; rejection leaves it untouched. */
  async decide(id: string, dto: z.infer<typeof decideLeaveSchema>) {
    const request = await prisma.leaveRequest.findFirst({ where: { id } });
    if (!request) throw new NotFoundError('Leave request');
    if (request.status !== 'PENDING') throw new ConflictError('This request has already been decided');

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: dto.status,
        approverId: actorMembershipId(),
        decidedAt: new Date(),
        decisionNote: dto.decisionNote ?? null,
      },
      select: requestSelect,
    });
    if (dto.status === 'APPROVED') {
      const year = request.startDate.getUTCFullYear();
      const balance = await this.ensureBalance(request.employeeId, request.leaveTypeId, year);
      await prisma.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: { increment: request.days } } });
    }
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'EMPLOYEE',
      entityId: request.employeeId,
      title: `Leave ${dto.status.toLowerCase()} — ${updated.leaveType.name} (${request.days}d)`,
      body: dto.decisionNote,
    });
    return updated;
  },

  /** Cancel a request; an approved one returns its days to the balance. */
  async cancel(id: string) {
    const request = await prisma.leaveRequest.findFirst({ where: { id } });
    if (!request) throw new NotFoundError('Leave request');
    if (['REJECTED', 'CANCELLED'].includes(request.status)) {
      throw new ConflictError('This request is already closed');
    }
    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: { status: 'CANCELLED', decidedAt: new Date() },
      select: requestSelect,
    });
    if (request.status === 'APPROVED') {
      const year = request.startDate.getUTCFullYear();
      const balance = await this.ensureBalance(request.employeeId, request.leaveTypeId, year);
      await prisma.leaveBalance.update({ where: { id: balance.id }, data: { usedDays: { decrement: request.days } } });
    }
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'EMPLOYEE',
      entityId: request.employeeId,
      title: `Leave cancelled — ${updated.leaveType.name} (${request.days}d)`,
    });
    return updated;
  },
};
