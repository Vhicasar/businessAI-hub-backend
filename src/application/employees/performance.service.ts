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

/** Derive progress% and status from a measurable goal's current vs target. */
export function goalProgress(currentValue: number | null, targetValue: number | null, explicit?: number): { progress: number; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'ACHIEVED' } {
  let progress: number;
  if (targetValue && targetValue > 0) {
    progress = Math.max(0, Math.min(100, Math.round(((currentValue ?? 0) / targetValue) * 100)));
  } else {
    progress = Math.max(0, Math.min(100, Math.round(explicit ?? 0)));
  }
  const status = progress >= 100 ? 'ACHIEVED' : progress > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';
  return { progress, status };
}

export const cycleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional(),
});
export const goalSchema = z.object({
  employeeId: z.string().min(1),
  cycleId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  type: z.enum(['KPI', 'OKR']).default('KPI'),
  targetValue: z.coerce.number().nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  weight: z.coerce.number().int().min(1).max(10).default(1),
  dueAt: z.coerce.date().nullable().optional(),
});
export const updateGoalSchema = z.object({
  currentValue: z.coerce.number().nullable().optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'MISSED']).optional(),
});
export const reviewSchema = z.object({
  overallRating: z.coerce.number().int().min(1).max(5),
  strengths: z.string().trim().max(4000).nullable().optional(),
  improvements: z.string().trim().max(4000).nullable().optional(),
  comments: z.string().trim().max(4000).nullable().optional(),
});
export const feedbackSchema = z.object({
  employeeId: z.string().min(1),
  type: z.enum(['PRAISE', 'CONSTRUCTIVE', 'GENERAL']).default('GENERAL'),
  body: z.string().trim().min(1).max(4000),
  isPrivate: z.boolean().default(false),
});
export const courseSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullable().optional(),
  category: z.string().trim().min(1).max(40).default('GENERAL'),
  durationMins: z.coerce.number().int().min(0).max(100_000).default(0),
  contentUrl: z.string().trim().max(500).nullable().optional(),
  isMandatory: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export const enrollSchema = z.object({
  courseId: z.string().min(1),
  employeeId: z.string().min(1),
  expiresAt: z.coerce.date().nullable().optional(),
});
export const progressSchema = z.object({
  progress: z.coerce.number().int().min(0).max(100),
  score: z.coerce.number().int().min(0).max(100).optional(),
});

const goalSelect = {
  id: true, title: true, description: true, type: true, targetValue: true, currentValue: true,
  unit: true, weight: true, progress: true, status: true, dueAt: true, cycleId: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;
const reviewSelect = {
  id: true, status: true, overallRating: true, strengths: true, improvements: true, comments: true,
  submittedAt: true, acknowledgedAt: true,
  cycle: { select: { id: true, name: true } },
  employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
} as const;

export const performanceService = {
  // ------------------------------------------------------------------ cycles
  async listCycles() {
    return prisma.performanceCycle.findMany({ orderBy: { periodStart: 'desc' }, take: 50 });
  },
  async createCycle(dto: z.infer<typeof cycleSchema>) {
    if (dto.periodEnd < dto.periodStart) throw new ValidationError('Period end cannot be before period start');
    const dup = await prisma.performanceCycle.findFirst({ where: { name: dto.name } });
    if (dup) throw new ConflictError(`A cycle named "${dto.name}" already exists`);
    return prisma.performanceCycle.create({
      data: { organizationId: orgId(), name: dto.name, periodStart: dto.periodStart, periodEnd: dto.periodEnd, status: dto.status ?? 'DRAFT' },
    });
  },
  /** Activating a cycle opens a PENDING review for every active employee. */
  async activateCycle(id: string) {
    const cycle = await prisma.performanceCycle.findFirst({ where: { id } });
    if (!cycle) throw new NotFoundError('Performance cycle');
    if (cycle.status !== 'DRAFT') throw new ConflictError('Only draft cycles can be activated');

    const employees = await prisma.employee.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (employees.length === 0) throw new ValidationError('No active employees to review');

    for (const e of employees) {
      const existing = await prisma.performanceReview.findFirst({ where: { cycleId: id, employeeId: e.id } });
      if (existing) continue;
      await prisma.performanceReview.create({
        data: { organizationId: orgId(), cycleId: id, employeeId: e.id, reviewerId: actorMembershipId() },
      });
    }
    return prisma.performanceCycle.update({ where: { id }, data: { status: 'ACTIVE' } });
  },
  async closeCycle(id: string) {
    const cycle = await prisma.performanceCycle.findFirst({ where: { id } });
    if (!cycle) throw new NotFoundError('Performance cycle');
    return prisma.performanceCycle.update({ where: { id }, data: { status: 'CLOSED' } });
  },

  // ----------------------------------------------------------------- reviews
  async listReviews(cycleId?: string, employeeId?: string) {
    return prisma.performanceReview.findMany({
      where: { ...(cycleId ? { cycleId } : {}), ...(employeeId ? { employeeId } : {}) },
      select: reviewSelect,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  },

  async submitReview(id: string, dto: z.infer<typeof reviewSchema>) {
    const review = await prisma.performanceReview.findFirst({ where: { id } });
    if (!review) throw new NotFoundError('Review');
    if (review.status === 'ACKNOWLEDGED') throw new ConflictError('This review is already acknowledged');

    const updated = await prisma.performanceReview.update({
      where: { id },
      data: {
        status: 'SUBMITTED',
        overallRating: dto.overallRating,
        strengths: dto.strengths ?? null,
        improvements: dto.improvements ?? null,
        comments: dto.comments ?? null,
        reviewerId: actorMembershipId(),
        submittedAt: new Date(),
      },
      select: reviewSelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: review.employeeId,
      title: `Performance review submitted — ${updated.cycle.name} (${dto.overallRating}/5)`,
    });
    return updated;
  },

  /** The employee confirms they've seen it — closes the loop. */
  async acknowledgeReview(id: string) {
    const review = await prisma.performanceReview.findFirst({ where: { id } });
    if (!review) throw new NotFoundError('Review');
    if (review.status !== 'SUBMITTED') throw new ConflictError('Only submitted reviews can be acknowledged');
    return prisma.performanceReview.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
      select: reviewSelect,
    });
  },

  // ------------------------------------------------------------------- goals
  async listGoals(employeeId?: string, cycleId?: string) {
    return prisma.goal.findMany({
      where: { ...(employeeId ? { employeeId } : {}), ...(cycleId ? { cycleId } : {}) },
      select: goalSelect,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      take: 200,
    });
  },

  async createGoal(dto: z.infer<typeof goalSchema>) {
    const employee = await prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } });
    if (!employee) throw new NotFoundError('Employee');
    return prisma.goal.create({
      data: {
        organizationId: orgId(),
        employeeId: dto.employeeId,
        cycleId: dto.cycleId ?? null,
        title: dto.title,
        description: dto.description ?? null,
        type: dto.type,
        targetValue: dto.targetValue ?? null,
        unit: dto.unit ?? null,
        weight: dto.weight,
        dueAt: dto.dueAt ?? null,
      },
      select: goalSelect,
    });
  },

  /** Progress auto-derives from current/target when the goal is measurable. */
  async updateGoal(id: string, dto: z.infer<typeof updateGoalSchema>) {
    const goal = await prisma.goal.findFirst({ where: { id } });
    if (!goal) throw new NotFoundError('Goal');

    const currentValue = dto.currentValue !== undefined ? dto.currentValue : goal.currentValue;
    const derived = goalProgress(currentValue, goal.targetValue, dto.progress ?? goal.progress);

    return prisma.goal.update({
      where: { id },
      data: {
        ...(dto.currentValue !== undefined ? { currentValue: dto.currentValue } : {}),
        progress: derived.progress,
        // An explicit status (e.g. MISSED) always wins over the derived one.
        status: dto.status ?? derived.status,
      },
      select: goalSelect,
    });
  },

  async deleteGoal(id: string) {
    await prisma.goal.deleteMany({ where: { id } });
    return { deleted: true };
  },

  // ---------------------------------------------------------------- feedback
  async listFeedback(employeeId: string) {
    return prisma.feedback.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, type: true, body: true, isPrivate: true, authorUserId: true, createdAt: true },
    });
  },

  async giveFeedback(dto: z.infer<typeof feedbackSchema>) {
    const employee = await prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } });
    if (!employee) throw new NotFoundError('Employee');
    const fb = await prisma.feedback.create({
      data: {
        organizationId: orgId(),
        employeeId: dto.employeeId,
        authorUserId: requestContext.get()?.userId ?? null,
        type: dto.type,
        body: dto.body,
        isPrivate: dto.isPrivate,
      },
    });
    // Private notes stay off the shared timeline.
    if (!dto.isPrivate) {
      await activityService.record({
        type: 'NOTE', entityType: 'EMPLOYEE', entityId: dto.employeeId,
        title: `Feedback — ${dto.type.toLowerCase()}`,
        body: dto.body,
      });
    }
    return fb;
  },

  // ----------------------------------------------------------------- courses
  async listCourses() {
    const courses = await prisma.course.findMany({ where: { isActive: true }, orderBy: { title: 'asc' } });
    const counts = await prisma.enrollment.groupBy({
      by: ['courseId', 'status'],
      where: { courseId: { in: courses.map((c) => c.id) } },
      _count: { _all: true },
    });
    return courses.map((c) => ({
      ...c,
      enrolled: counts.filter((x) => x.courseId === c.id).reduce((s, x) => s + x._count._all, 0),
      completed: counts.find((x) => x.courseId === c.id && x.status === 'COMPLETED')?._count._all ?? 0,
    }));
  },
  async createCourse(dto: z.infer<typeof courseSchema>) {
    const dup = await prisma.course.findFirst({ where: { title: dto.title } });
    if (dup) throw new ConflictError(`A course named "${dto.title}" already exists`);
    return prisma.course.create({ data: { organizationId: orgId(), ...dto } });
  },
  async updateCourse(id: string, dto: z.infer<typeof courseSchema>) {
    const existing = await prisma.course.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Course');
    return prisma.course.update({ where: { id }, data: dto });
  },
  async deleteCourse(id: string) {
    const enrolled = await prisma.enrollment.count({ where: { courseId: id } });
    if (enrolled > 0) throw new ConflictError('Course has enrollments — deactivate it instead');
    await prisma.course.deleteMany({ where: { id } });
    return { deleted: true };
  },

  /** Enroll every active employee onto a mandatory course (compliance training). */
  async enrollAll(courseId: string) {
    const course = await prisma.course.findFirst({ where: { id: courseId, isActive: true } });
    if (!course) throw new NotFoundError('Course');
    const employees = await prisma.employee.findMany({ where: { deletedAt: null, status: 'ACTIVE' }, select: { id: true } });
    let created = 0;
    for (const e of employees) {
      const existing = await prisma.enrollment.findFirst({ where: { courseId, employeeId: e.id } });
      if (existing) continue;
      await prisma.enrollment.create({ data: { organizationId: orgId(), courseId, employeeId: e.id } });
      created += 1;
    }
    return { enrolled: created };
  },

  async listEnrollments(employeeId?: string, status?: string) {
    return prisma.enrollment.findMany({
      where: {
        ...(employeeId ? { employeeId } : {}),
        ...(status ? { status: status as 'ENROLLED' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED' } : {}),
      },
      orderBy: { enrolledAt: 'desc' },
      take: 200,
      select: {
        id: true, status: true, progress: true, score: true, enrolledAt: true, completedAt: true, expiresAt: true,
        course: { select: { id: true, title: true, category: true, isMandatory: true, durationMins: true } },
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      },
    });
  },

  async enroll(dto: z.infer<typeof enrollSchema>) {
    const [course, employee] = await Promise.all([
      prisma.course.findFirst({ where: { id: dto.courseId, isActive: true } }),
      prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } }),
    ]);
    if (!course) throw new NotFoundError('Course');
    if (!employee) throw new NotFoundError('Employee');
    const existing = await prisma.enrollment.findFirst({ where: { courseId: dto.courseId, employeeId: dto.employeeId } });
    if (existing) throw new ConflictError('Employee is already enrolled on this course');
    return prisma.enrollment.create({
      data: { organizationId: orgId(), courseId: dto.courseId, employeeId: dto.employeeId, expiresAt: dto.expiresAt ?? null },
    });
  },

  /** Record progress; hitting 100% completes the enrollment and stamps the date. */
  async setProgress(id: string, dto: z.infer<typeof progressSchema>) {
    const enrollment = await prisma.enrollment.findFirst({ where: { id }, include: { course: true } });
    if (!enrollment) throw new NotFoundError('Enrollment');
    const done = dto.progress >= 100;
    const updated = await prisma.enrollment.update({
      where: { id },
      data: {
        progress: dto.progress,
        status: done ? 'COMPLETED' : dto.progress > 0 ? 'IN_PROGRESS' : 'ENROLLED',
        ...(dto.score !== undefined ? { score: dto.score } : {}),
        ...(done && !enrollment.completedAt ? { completedAt: new Date() } : {}),
      },
    });
    if (done && !enrollment.completedAt) {
      await activityService.record({
        type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: enrollment.employeeId,
        title: `Course completed — ${enrollment.course.title}`,
        body: dto.score !== undefined ? `Score ${dto.score}%` : undefined,
      });
    }
    return updated;
  },
};
