import { NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { callerHasPermission } from '../roles/role-permissions';
import { canSeeSalary } from './employees.service';
import { filesService } from '../files/files.service';

/**
 * The employee profile: everything the organisation knows about one person,
 * pulled together from the modules that hold it.
 *
 * Two rules shape this file:
 *
 * 1. **Sections are permission-gated, not just hidden.** A profile is a
 *    convenient place to accidentally leak salary, payslips or interview
 *    feedback to someone who can see the staff directory and nothing else.
 *    Each section is fetched only when the caller holds that module's read
 *    permission, and returns `null` otherwise — so the UI can say "you don't
 *    have access" rather than silently implying the person has no data.
 *
 * 2. **Sales and support work is owned by a *membership*, not an employee.**
 *    An employee with no user account has no membership, so no deals or leads
 *    can point at them. That isn't an error — it's the normal state of someone
 *    who was imported but never invited — so those sections report
 *    `linked: false` instead of zeroes, which would be a lie.
 */

const DAYS_OF_ATTENDANCE = 30;

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Decimal | null → number, without trusting Prisma's Decimal to coerce. */
const money = (v: unknown): number => (v == null ? 0 : Number(v));

export const employeeProfileService = {
  async get(employeeId: string) {
    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: {
        id: true, employeeNumber: true, firstName: true, lastName: true, email: true, phone: true,
        jobTitle: true, employmentType: true, status: true, hiredAt: true, terminatedAt: true,
        salary: true, currency: true, userId: true, createdAt: true, departmentId: true, avatarFileId: true,
      },
    });
    if (!employee) throw new NotFoundError('Employee');

    // Employee has no `department` relation — only the FK scalar — so resolve
    // the name separately, the same way the rest of the app does.
    const department = employee.departmentId
      ? await prisma.department.findFirst({
          where: { id: employee.departmentId },
          select: { id: true, name: true, code: true },
        })
      : null;

    const avatarUrl = await filesService.urlFor(employee.avatarFileId);
    const { salary, ...rest } = employee;
    const profile = { ...((await canSeeSalary()) ? employee : rest), department, avatarUrl };

    // The account link is what connects this person to everything they *do*.
    const membership = employee.userId
      ? await prisma.membership.findFirst({
          where: { userId: employee.userId, deletedAt: null },
          select: {
            id: true, isActive: true, createdAt: true,
            role: { select: { id: true, name: true } },
            user: { select: { email: true, lastLoginAt: true } },
          },
        })
      : null;

    const [sales, support, hr, performance, activity] = await Promise.all([
      this.sales(membership?.id ?? null),
      this.support(membership?.id ?? null),
      this.hr(employeeId),
      this.performance(employeeId),
      this.activity(employee.userId),
    ]);

    return {
      employee: profile,
      account: membership
        ? {
            linked: true as const,
            membershipId: membership.id,
            isActive: membership.isActive,
            role: membership.role,
            email: membership.user.email,
            lastLoginAt: membership.user.lastLoginAt,
            memberSince: membership.createdAt,
          }
        : {
            linked: false as const,
            // Explains the empty sales/support sections, and tells the UI it can
            // offer an invite instead of showing misleading zeroes.
            reason: employee.email
              ? 'This employee has no user account yet — invite them to track their sales, support and activity.'
              : 'This employee has no email address, so they cannot be invited to a user account yet.',
            canInvite: Boolean(employee.email) && employee.status === 'ACTIVE',
          },
      sales,
      support,
      hr,
      performance,
      activity,
    };
  },

  /** Deals and leads owned by this person. Null when they have no account. */
  async sales(membershipId: string | null) {
    if (!(await callerHasPermission('crm.read'))) return null;
    if (!membershipId) return { linked: false as const };

    const [deals, leads, recentDeals] = await Promise.all([
      prisma.deal.groupBy({
        by: ['status'],
        where: { ownerId: membershipId, deletedAt: null },
        _count: { _all: true },
        _sum: { value: true },
      }),
      prisma.lead.groupBy({
        by: ['status'],
        where: { ownerId: membershipId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.deal.findMany({
        where: { ownerId: membershipId, deletedAt: null },
        select: {
          id: true, title: true, value: true, currency: true, status: true,
          closedAt: true, updatedAt: true,
          stage: { select: { name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 8,
      }),
    ]);

    const dealStat = (s: string) => deals.find((d) => d.status === s);
    const won = dealStat('WON');
    const lost = dealStat('LOST');
    const open = dealStat('OPEN');
    const wonCount = won?._count._all ?? 0;
    const lostCount = lost?._count._all ?? 0;

    const leadCount = (s: string) => leads.find((l) => l.status === s)?._count._all ?? 0;
    const totalLeads = leads.reduce((sum, l) => sum + l._count._all, 0);
    const converted = leadCount('CONVERTED');

    return {
      linked: true as const,
      deals: {
        won: { count: wonCount, value: money(won?._sum.value) },
        lost: { count: lostCount, value: money(lost?._sum.value) },
        open: { count: open?._count._all ?? 0, value: money(open?._sum.value) },
        // Win rate deliberately excludes open deals: they haven't been decided,
        // and counting them as not-won would understate a healthy pipeline.
        winRate: pct(wonCount, wonCount + lostCount),
      },
      leads: {
        total: totalLeads,
        converted,
        conversionRate: pct(converted, totalLeads),
        byStatus: Object.fromEntries(leads.map((l) => [l.status, l._count._all])),
      },
      recentDeals,
    };
  },

  async support(membershipId: string | null) {
    if (!(await callerHasPermission('support.read'))) return null;
    if (!membershipId) return { linked: false as const };

    const [tickets, recentTickets, csat] = await Promise.all([
      prisma.ticket.groupBy({
        by: ['status'],
        where: { assigneeId: membershipId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.ticket.findMany({
        where: { assigneeId: membershipId, deletedAt: null },
        select: {
          id: true, number: true, subject: true, status: true, priority: true,
          resolvedAt: true, updatedAt: true, satisfactionScore: true,
          customer: { select: { id: true, firstName: true, lastName: true } },
        },
        // Open work first, then the most recently touched — a queue reads better
        // than a changelog when you're looking at who's carrying what.
        orderBy: [{ resolvedAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'desc' }],
        take: 10,
      }),
      prisma.ticket.aggregate({
        where: { assigneeId: membershipId, deletedAt: null, satisfactionScore: { not: null } },
        _avg: { satisfactionScore: true },
        _count: { satisfactionScore: true },
      }),
    ]);

    const count = (s: string) => tickets.find((t) => t.status === s)?._count._all ?? 0;
    const total = tickets.reduce((sum, t) => sum + t._count._all, 0);
    const closed = count('RESOLVED') + count('CLOSED');

    return {
      linked: true as const,
      total,
      resolved: closed,
      open: total - closed,
      escalated: count('ESCALATED'),
      resolutionRate: pct(closed, total),
      byStatus: Object.fromEntries(tickets.map((t) => [t.status, t._count._all])),
      // Null rather than 0 when nobody has rated them — an unrated agent is not
      // a zero-star agent.
      csat: csat._count.satisfactionScore
        ? { average: Math.round((csat._avg.satisfactionScore ?? 0) * 10) / 10, responses: csat._count.satisfactionScore }
        : null,
      recentTickets,
    };
  },

  /** Leave, attendance and assets — each behind its own module permission. */
  async hr(employeeId: string) {
    const [mayLeave, mayAttendance, mayAssets] = await Promise.all([
      callerHasPermission('leave.read'),
      callerHasPermission('attendance.read'),
      callerHasPermission('assets.read'),
    ]);

    const since = new Date();
    since.setDate(since.getDate() - DAYS_OF_ATTENDANCE);

    const [balances, attendance, assets] = await Promise.all([
      mayLeave
        ? prisma.leaveBalance.findMany({
            where: { employeeId, year: new Date().getFullYear() },
            select: {
              entitledDays: true, usedDays: true, carriedOverDays: true,
              leaveType: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve(null),
      mayAttendance
        ? prisma.attendanceRecord.groupBy({
            by: ['status'],
            where: { employeeId, date: { gte: since } },
            _count: { _all: true },
            _sum: { workedMinutes: true, overtimeMinutes: true, lateMinutes: true },
          })
        : Promise.resolve(null),
      mayAssets
        ? prisma.assetAssignment.findMany({
            where: { employeeId, returnedAt: null },
            select: {
              id: true, assignedAt: true,
              asset: { select: { id: true, name: true, assetTag: true, category: true } },
            },
          })
        : Promise.resolve(null),
    ]);

    return {
      leave: balances
        ? balances.map((b) => ({
            leaveType: b.leaveType,
            entitled: b.entitledDays + b.carriedOverDays,
            used: b.usedDays,
            remaining: b.entitledDays + b.carriedOverDays - b.usedDays,
          }))
        : null,
      attendance: attendance
        ? {
            windowDays: DAYS_OF_ATTENDANCE,
            byStatus: Object.fromEntries(attendance.map((a) => [a.status, a._count._all])),
            daysRecorded: attendance.reduce((s, a) => s + a._count._all, 0),
            workedHours: Math.round(attendance.reduce((s, a) => s + (a._sum.workedMinutes ?? 0), 0) / 6) / 10,
            overtimeHours: Math.round(attendance.reduce((s, a) => s + (a._sum.overtimeMinutes ?? 0), 0) / 6) / 10,
            lateMinutes: attendance.reduce((s, a) => s + (a._sum.lateMinutes ?? 0), 0),
          }
        : null,
      // Keep the assignment id and the asset id distinct — spreading the asset
      // over an `id` key would silently replace one with the other.
      assets: assets
        ? assets.map((a) => ({ assignmentId: a.id, assignedAt: a.assignedAt, ...a.asset }))
        : null,
    };
  },

  async performance(employeeId: string) {
    if (!(await callerHasPermission('performance.read'))) return null;

    const [reviews, goals] = await Promise.all([
      prisma.performanceReview.findMany({
        where: { employeeId },
        select: {
          id: true, status: true, overallRating: true, submittedAt: true, acknowledgedAt: true,
          cycle: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      prisma.goal.findMany({
        where: { employeeId },
        select: { id: true, title: true, status: true, progress: true, targetValue: true, currentValue: true, dueAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const rated = reviews.filter((r) => r.overallRating != null);
    return {
      reviews,
      goals,
      // Only meaningful once something has actually been rated.
      averageRating: rated.length
        ? Math.round((rated.reduce((s, r) => s + (r.overallRating ?? 0), 0) / rated.length) * 10) / 10
        : null,
      goalsAchieved: goals.filter((g) => g.status === 'ACHIEVED').length,
    };
  },

  /** What this person did, org-wide — not what was done to them. */
  async activity(userId: string | null) {
    if (!userId) return { linked: false as const, items: [] };
    const items = await prisma.activity.findMany({
      where: { actorUserId: userId },
      select: { id: true, type: true, entityType: true, entityId: true, title: true, body: true, occurredAt: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 25,
    });
    return { linked: true as const, items };
  },
};
