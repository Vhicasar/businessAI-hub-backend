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

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Midnight UTC for a date — attendance/roster rows are keyed by calendar day. */
export function dayKey(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** "09:30" → 570 minutes past midnight. */
export function toMinutes(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new ValidationError(`Invalid time "${hhmm}" — expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Scheduled length of a shift in minutes, minus breaks. Handles overnight wrap. */
export function shiftMinutes(startTime: string, endTime: string, breakMinutes = 0): number {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const span = end > start ? end - start : 24 * 60 - start + end; // wraps past midnight
  return Math.max(0, span - breakMinutes);
}

export const shiftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  startTime: z.string().regex(TIME_RE, 'Use HH:MM'),
  endTime: z.string().regex(TIME_RE, 'Use HH:MM'),
  breakMinutes: z.coerce.number().int().min(0).max(480).default(0),
  daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
  isActive: z.boolean().default(true),
});
export const assignShiftSchema = z.object({
  employeeId: z.string().min(1),
  shiftId: z.string().min(1),
  date: z.coerce.date(),
});
export const clockSchema = z.object({
  employeeId: z.string().min(1),
  source: z.enum(['WEB', 'GPS', 'QR', 'BIOMETRIC']).default('WEB'),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export const listAttendanceSchema = z.object({
  employeeId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE', 'HALF_DAY']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const attendanceSelect = {
  id: true, date: true, clockInAt: true, clockOutAt: true, breakMinutes: true,
  workedMinutes: true, overtimeMinutes: true, lateMinutes: true, status: true, source: true, notes: true,
  employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
  shift: { select: { id: true, name: true, startTime: true, endTime: true } },
} as const;

export const attendanceService = {
  // ------------------------------------------------------------------ shifts
  async listShifts() {
    return prisma.shift.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  },
  async createShift(dto: z.infer<typeof shiftSchema>) {
    const dup = await prisma.shift.findFirst({ where: { name: dto.name } });
    if (dup) throw new ConflictError(`A shift named "${dto.name}" already exists`);
    return prisma.shift.create({ data: { organizationId: orgId(), ...dto } });
  },
  async updateShift(id: string, dto: z.infer<typeof shiftSchema>) {
    const existing = await prisma.shift.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Shift');
    return prisma.shift.update({ where: { id }, data: dto });
  },
  async deleteShift(id: string) {
    const inUse = await prisma.shiftAssignment.count({ where: { shiftId: id } });
    if (inUse > 0) throw new ConflictError('Shift is rostered — deactivate it instead');
    await prisma.shift.deleteMany({ where: { id } });
    return { deleted: true };
  },

  // ------------------------------------------------------------------ roster
  async listRoster(from: Date, to: Date) {
    return prisma.shiftAssignment.findMany({
      where: { date: { gte: dayKey(from), lte: dayKey(to) } },
      orderBy: { date: 'asc' },
      select: {
        id: true, date: true,
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
        shift: { select: { id: true, name: true, startTime: true, endTime: true } },
      },
    });
  },

  /** Roster an employee onto a shift for a day (one shift per employee per day). */
  async assignShift(dto: z.infer<typeof assignShiftSchema>) {
    const [employee, shift] = await Promise.all([
      prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } }),
      prisma.shift.findFirst({ where: { id: dto.shiftId, isActive: true } }),
    ]);
    if (!employee) throw new NotFoundError('Employee');
    if (!shift) throw new NotFoundError('Shift');
    const date = dayKey(dto.date);

    const existing = await prisma.shiftAssignment.findFirst({ where: { employeeId: dto.employeeId, date } });
    if (existing) {
      return prisma.shiftAssignment.update({
        where: { id: existing.id },
        data: { shiftId: dto.shiftId },
        select: { id: true, date: true, shift: { select: { id: true, name: true } } },
      });
    }
    return prisma.shiftAssignment.create({
      data: { organizationId: orgId(), employeeId: dto.employeeId, shiftId: dto.shiftId, date },
      select: { id: true, date: true, shift: { select: { id: true, name: true } } },
    });
  },

  async unassignShift(id: string) {
    const existing = await prisma.shiftAssignment.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Shift assignment');
    await prisma.shiftAssignment.deleteMany({ where: { id } });
    return { deleted: true };
  },

  // -------------------------------------------------------------- attendance
  async list(dto: z.infer<typeof listAttendanceSchema>) {
    return prisma.attendanceRecord.findMany({
      where: {
        ...(dto.employeeId ? { employeeId: dto.employeeId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.from || dto.to
          ? {
              date: {
                ...(dto.from ? { gte: dayKey(dto.from) } : {}),
                ...(dto.to ? { lte: dayKey(dto.to) } : {}),
              },
            }
          : {}),
      },
      select: attendanceSelect,
      orderBy: [{ date: 'desc' }, { clockInAt: 'desc' }],
      take: dto.limit,
    });
  },

  /**
   * Clock in for today. Uses the day's rostered shift (if any) to flag lateness.
   */
  async clockIn(dto: z.infer<typeof clockSchema>) {
    const employee = await prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } });
    if (!employee) throw new NotFoundError('Employee');
    const now = new Date();
    const date = dayKey(now);

    const existing = await prisma.attendanceRecord.findFirst({ where: { employeeId: dto.employeeId, date } });
    if (existing?.clockInAt) throw new ConflictError('Already clocked in today');

    const assignment = await prisma.shiftAssignment.findFirst({
      where: { employeeId: dto.employeeId, date },
      select: { shiftId: true, shift: { select: { startTime: true, breakMinutes: true } } },
    });

    // Late = minutes past the rostered start time.
    let lateMinutes = 0;
    if (assignment?.shift) {
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
      lateMinutes = Math.max(0, nowMins - toMinutes(assignment.shift.startTime));
    }

    const data = {
      clockInAt: now,
      shiftId: assignment?.shiftId ?? null,
      breakMinutes: assignment?.shift?.breakMinutes ?? 0,
      lateMinutes,
      status: (lateMinutes > 0 ? 'LATE' : 'PRESENT') as 'LATE' | 'PRESENT',
      source: dto.source,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      notes: dto.notes ?? null,
    };

    const record = existing
      ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data, select: attendanceSelect })
      : await prisma.attendanceRecord.create({
          data: { organizationId: orgId(), employeeId: dto.employeeId, date, ...data },
          select: attendanceSelect,
        });

    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: dto.employeeId,
      title: `Clocked in${lateMinutes > 0 ? ` — ${lateMinutes}m late` : ''}`,
      body: `${dto.source.toLowerCase()}${dto.latitude != null ? ` · ${dto.latitude},${dto.longitude}` : ''}`,
    });
    return record;
  },

  /** Clock out — computes worked minutes (minus break) and overtime vs. the shift. */
  async clockOut(dto: z.infer<typeof clockSchema>) {
    const now = new Date();
    const date = dayKey(now);
    const existing = await prisma.attendanceRecord.findFirst({
      where: { employeeId: dto.employeeId, date },
      include: { shift: true },
    });
    if (!existing?.clockInAt) throw new ConflictError('Not clocked in today');
    if (existing.clockOutAt) throw new ConflictError('Already clocked out today');

    const rawMinutes = Math.max(0, Math.round((now.getTime() - existing.clockInAt.getTime()) / 60_000));
    const workedMinutes = Math.max(0, rawMinutes - existing.breakMinutes);
    const scheduled = existing.shift
      ? shiftMinutes(existing.shift.startTime, existing.shift.endTime, existing.shift.breakMinutes)
      : 0;
    const overtimeMinutes = scheduled > 0 ? Math.max(0, workedMinutes - scheduled) : 0;

    const record = await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: { clockOutAt: now, workedMinutes, overtimeMinutes },
      select: attendanceSelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: dto.employeeId,
      title: `Clocked out — ${(workedMinutes / 60).toFixed(2)}h worked${overtimeMinutes > 0 ? ` (+${overtimeMinutes}m OT)` : ''}`,
    });
    return record;
  },

  /** Today's record for an employee (drives the clock in/out button state). */
  async today(employeeId: string) {
    return prisma.attendanceRecord.findFirst({
      where: { employeeId, date: dayKey(new Date()) },
      select: attendanceSelect,
    });
  },

  /** Per-employee totals for a period. */
  async summary(from: Date, to: Date) {
    const rows = await prisma.attendanceRecord.findMany({
      where: { date: { gte: dayKey(from), lte: dayKey(to) } },
      select: {
        workedMinutes: true, overtimeMinutes: true, lateMinutes: true, status: true,
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const map = new Map<string, { name: string; days: number; workedMinutes: number; overtimeMinutes: number; lateDays: number }>();
    for (const r of rows) {
      const row = map.get(r.employee.id) ?? {
        name: `${r.employee.firstName} ${r.employee.lastName}`.trim(),
        days: 0, workedMinutes: 0, overtimeMinutes: 0, lateDays: 0,
      };
      row.days += 1;
      row.workedMinutes += r.workedMinutes;
      row.overtimeMinutes += r.overtimeMinutes;
      if (r.status === 'LATE') row.lateDays += 1;
      map.set(r.employee.id, row);
    }
    return [...map.values()].sort((a, b) => b.workedMinutes - a.workedMinutes);
  },
};
