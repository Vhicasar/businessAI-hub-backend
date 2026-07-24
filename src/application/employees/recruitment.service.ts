import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';
import { employeesService } from './employees.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}

const STAGES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'] as const;
const JOB_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'FILLED'] as const;

/** On/offboarding checklists live in org.settings.hr (no extra table). */
export interface ChecklistItem {
  title: string;
  dueInDays: number;
}
interface HrChecklists {
  onboarding: ChecklistItem[];
  offboarding: ChecklistItem[];
}
const DEFAULT_CHECKLISTS: HrChecklists = {
  onboarding: [
    { title: 'Prepare workstation and accounts', dueInDays: 0 },
    { title: 'Assign equipment', dueInDays: 1 },
    { title: 'Send welcome pack and contract', dueInDays: 1 },
    { title: 'Schedule orientation', dueInDays: 3 },
    { title: 'Assign a mentor', dueInDays: 5 },
  ],
  offboarding: [
    { title: 'Revoke system access', dueInDays: 0 },
    { title: 'Schedule exit interview', dueInDays: 3 },
    { title: 'Finalise last payroll', dueInDays: 7 },
    { title: 'Archive employee records', dueInDays: 14 },
  ],
};

export const checklistsSchema = z.object({
  onboarding: z.array(z.object({ title: z.string().trim().min(1).max(160), dueInDays: z.coerce.number().int().min(0).max(365) })).max(50),
  offboarding: z.array(z.object({ title: z.string().trim().min(1).max(160), dueInDays: z.coerce.number().int().min(0).max(365) })).max(50),
});

export const jobPostingSchema = z.object({
  title: z.string().trim().min(1).max(160),
  departmentId: z.string().nullable().optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']).default('FULL_TIME'),
  location: z.string().trim().max(120).nullable().optional(),
  openings: z.coerce.number().int().min(1).max(999).default(1),
  salaryMin: z.coerce.number().min(0).nullable().optional(),
  salaryMax: z.coerce.number().min(0).nullable().optional(),
  status: z.enum(JOB_STATUSES).optional(),
});
export const applicantSchema = z.object({
  jobPostingId: z.string().min(1),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  resumeUrl: z.string().trim().max(500).nullable().optional(),
  resumeText: z.string().trim().max(20_000).nullable().optional(),
  source: z.string().trim().max(40).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export const moveStageSchema = z.object({ stage: z.enum(STAGES) });
export const hireSchema = z.object({
  jobTitle: z.string().trim().max(120).nullable().optional(),
  departmentId: z.string().nullable().optional(),
  salary: z.coerce.number().min(0).nullable().optional(),
  hiredAt: z.coerce.date().nullable().optional(),
});
export const interviewSchema = z.object({
  applicantId: z.string().min(1),
  scheduledAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(5).max(480).default(45),
  interviewerId: z.string().min(1).nullable().optional(),
  mode: z.enum(['VIDEO', 'PHONE', 'ONSITE']).default('VIDEO'),
  meetingUrl: z.string().trim().max(500).nullable().optional(),
});
export const interviewFeedbackSchema = z.object({
  status: z.enum(['COMPLETED', 'CANCELLED', 'NO_SHOW']),
  feedback: z.string().trim().max(4000).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
});
export const listApplicantsSchema = z.object({
  jobPostingId: z.string().optional(),
  stage: z.enum(STAGES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const jobSelect = {
  id: true, reference: true, title: true, departmentId: true, description: true, employmentType: true,
  location: true, status: true, openings: true, salaryMin: true, salaryMax: true, currency: true,
  publishedAt: true, createdAt: true,
} as const;
const applicantSelect = {
  id: true, firstName: true, lastName: true, email: true, phone: true, resumeUrl: true,
  source: true, stage: true, aiScore: true, aiScoreReason: true, notes: true, hiredEmployeeId: true, appliedAt: true,
  jobPosting: { select: { id: true, title: true, reference: true } },
} as const;

async function nextJobRef(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.jobPosting.count({ where: { reference: { startsWith: `JOB-${year}-` } } });
  return `JOB-${year}-${String(count + 1).padStart(4, '0')}`;
}

async function readChecklists(): Promise<HrChecklists> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
  const hr = ((org.settings as Record<string, unknown>) ?? {}).hr as Partial<HrChecklists> | undefined;
  return {
    onboarding: hr?.onboarding ?? DEFAULT_CHECKLISTS.onboarding,
    offboarding: hr?.offboarding ?? DEFAULT_CHECKLISTS.offboarding,
  };
}

/** Materialise a checklist as real Tasks linked to the employee. */
async function generateTasks(employeeId: string, items: ChecklistItem[], label: string) {
  for (const item of items) {
    await prisma.task.create({
      data: {
        organizationId: orgId(),
        title: `${label}: ${item.title}`,
        assigneeId: actorMembershipId(),
        createdById: actorMembershipId(),
        entityType: 'EMPLOYEE',
        entityId: employeeId,
        dueAt: new Date(Date.now() + item.dueInDays * 86_400_000),
      },
    });
  }
}

export const recruitmentService = {
  // ------------------------------------------------------------- checklists
  async getChecklists() {
    return readChecklists();
  },
  async saveChecklists(dto: z.infer<typeof checklistsSchema>) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    const hr = (settings.hr as Record<string, unknown>) ?? {};
    await prisma.organization.update({
      where: { id: orgId() },
      data: { settings: { ...settings, hr: { ...hr, ...dto } } },
    });
    return dto;
  },

  // ----------------------------------------------------------- job postings
  async listJobs() {
    const jobs = await prisma.jobPosting.findMany({
      where: { deletedAt: null },
      select: jobSelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const counts = await prisma.applicant.groupBy({
      by: ['jobPostingId'],
      where: { jobPostingId: { in: jobs.map((j) => j.id) } },
      _count: { _all: true },
    });
    return jobs.map((j) => ({ ...j, applicantCount: counts.find((c) => c.jobPostingId === j.id)?._count._all ?? 0 }));
  },

  async createJob(dto: z.infer<typeof jobPostingSchema>) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { currency: true } });
    return prisma.jobPosting.create({
      data: {
        organizationId: orgId(),
        reference: await nextJobRef(),
        title: dto.title,
        departmentId: dto.departmentId ?? null,
        description: dto.description ?? null,
        employmentType: dto.employmentType,
        location: dto.location ?? null,
        openings: dto.openings,
        salaryMin: dto.salaryMin ?? null,
        salaryMax: dto.salaryMax ?? null,
        currency: org.currency,
        status: dto.status ?? 'DRAFT',
        ...(dto.status === 'OPEN' ? { publishedAt: new Date() } : {}),
      },
      select: jobSelect,
    });
  },

  async updateJob(id: string, dto: z.infer<typeof jobPostingSchema>) {
    const existing = await prisma.jobPosting.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Job posting');
    const publishing = dto.status === 'OPEN' && existing.status !== 'OPEN';
    const closing = dto.status && ['CLOSED', 'FILLED'].includes(dto.status) && !['CLOSED', 'FILLED'].includes(existing.status);
    return prisma.jobPosting.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.departmentId !== undefined ? { departmentId: dto.departmentId } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.employmentType !== undefined ? { employmentType: dto.employmentType } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.openings !== undefined ? { openings: dto.openings } : {}),
        ...(dto.salaryMin !== undefined ? { salaryMin: dto.salaryMin } : {}),
        ...(dto.salaryMax !== undefined ? { salaryMax: dto.salaryMax } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(publishing ? { publishedAt: new Date() } : {}),
        ...(closing ? { closedAt: new Date() } : {}),
      },
      select: jobSelect,
    });
  },

  async deleteJob(id: string) {
    const applicants = await prisma.applicant.count({ where: { jobPostingId: id } });
    if (applicants > 0) throw new ConflictError('Posting has applicants — close it instead');
    await prisma.jobPosting.update({ where: { id }, data: { deletedAt: new Date(), status: 'CLOSED' } });
    return { deleted: true };
  },

  // -------------------------------------------------------------- applicants
  async listApplicants(dto: z.infer<typeof listApplicantsSchema>) {
    return prisma.applicant.findMany({
      where: {
        ...(dto.jobPostingId ? { jobPostingId: dto.jobPostingId } : {}),
        ...(dto.stage ? { stage: dto.stage } : {}),
      },
      select: applicantSelect,
      orderBy: [{ aiScore: 'desc' }, { appliedAt: 'desc' }],
      take: dto.limit,
    });
  },

  async getApplicant(id: string) {
    const applicant = await prisma.applicant.findFirst({
      where: { id },
      select: { ...applicantSelect, resumeText: true },
    });
    if (!applicant) throw new NotFoundError('Applicant');
    const interviews = await prisma.interview.findMany({
      where: { applicantId: id },
      orderBy: { scheduledAt: 'desc' },
      select: { id: true, scheduledAt: true, durationMin: true, mode: true, meetingUrl: true, status: true, feedback: true, rating: true },
    });
    return { ...applicant, interviews };
  },

  async createApplicant(dto: z.infer<typeof applicantSchema>) {
    const job = await prisma.jobPosting.findFirst({ where: { id: dto.jobPostingId, deletedAt: null } });
    if (!job) throw new NotFoundError('Job posting');
    if (['CLOSED', 'FILLED'].includes(job.status)) throw new ConflictError('This posting is no longer accepting applicants');

    // One application per email per posting.
    if (dto.email) {
      const dup = await prisma.applicant.findFirst({ where: { jobPostingId: dto.jobPostingId, email: dto.email } });
      if (dup) throw new ConflictError('This candidate has already applied for this role');
    }
    return prisma.applicant.create({
      data: {
        organizationId: orgId(),
        jobPostingId: dto.jobPostingId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        resumeUrl: dto.resumeUrl ?? null,
        resumeText: dto.resumeText ?? null,
        source: dto.source ?? 'MANUAL',
        notes: dto.notes ?? null,
      },
      select: applicantSelect,
    });
  },

  async moveStage(id: string, stage: (typeof STAGES)[number]) {
    const applicant = await prisma.applicant.findFirst({ where: { id } });
    if (!applicant) throw new NotFoundError('Applicant');
    if (applicant.stage === 'HIRED') throw new ConflictError('Hired applicants cannot change stage');
    if (stage === 'HIRED') throw new ConflictError('Use the hire action to convert an applicant to an employee');
    return prisma.applicant.update({ where: { id }, data: { stage }, select: applicantSelect });
  },

  /**
   * Convert an applicant into an Employee and kick off onboarding tasks.
   * Fills the posting when its openings are all taken.
   */
  async hire(id: string, dto: z.infer<typeof hireSchema>) {
    const applicant = await prisma.applicant.findFirst({ where: { id }, include: { jobPosting: true } });
    if (!applicant) throw new NotFoundError('Applicant');
    if (applicant.stage === 'HIRED') throw new ConflictError('Applicant is already hired');
    if (applicant.stage === 'REJECTED') throw new ConflictError('Rejected applicants cannot be hired');

    const employee = await employeesService.create({
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      email: applicant.email,
      phone: applicant.phone,
      jobTitle: dto.jobTitle ?? applicant.jobPosting.title,
      departmentId: dto.departmentId ?? applicant.jobPosting.departmentId,
      employmentType: applicant.jobPosting.employmentType,
      salary: dto.salary ?? null,
      hiredAt: dto.hiredAt ?? new Date(),
    });

    await prisma.applicant.update({ where: { id }, data: { stage: 'HIRED', hiredEmployeeId: employee.id } });

    const { onboarding } = await readChecklists();
    await generateTasks(employee.id, onboarding, 'Onboarding');

    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: employee.id,
      title: `Hired — ${applicant.jobPosting.title}`,
      body: `From applicant ${applicant.firstName} ${applicant.lastName} · ${onboarding.length} onboarding task(s) created`,
    });

    // Fill the posting once its openings are covered.
    const hiredCount = await prisma.applicant.count({ where: { jobPostingId: applicant.jobPostingId, stage: 'HIRED' } });
    if (hiredCount >= applicant.jobPosting.openings) {
      await prisma.jobPosting.update({
        where: { id: applicant.jobPostingId },
        data: { status: 'FILLED', closedAt: new Date() },
      });
    }
    return { employee, onboardingTasks: onboarding.length };
  },

  /**
   * Offboard an employee: terminate, generate the offboarding checklist, and
   * raise a recovery task for every asset still in their custody (H4).
   */
  async offboard(employeeId: string) {
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null } });
    if (!employee) throw new NotFoundError('Employee');
    if (employee.status === 'TERMINATED') throw new ConflictError('Employee is already offboarded');

    await prisma.employee.update({
      where: { id: employeeId },
      data: { status: 'TERMINATED', terminatedAt: new Date() },
    });

    const { offboarding } = await readChecklists();
    await generateTasks(employeeId, offboarding, 'Offboarding');

    // Anything still assigned needs recovering.
    const heldAssets = await prisma.assetAssignment.findMany({
      where: { employeeId, returnedAt: null },
      select: { asset: { select: { name: true, assetTag: true } } },
    });
    for (const a of heldAssets) {
      await prisma.task.create({
        data: {
          organizationId: orgId(),
          title: `Offboarding: recover ${a.asset.name} (${a.asset.assetTag})`,
          assigneeId: actorMembershipId(),
          createdById: actorMembershipId(),
          entityType: 'EMPLOYEE',
          entityId: employeeId,
          priority: 'HIGH',
          dueAt: new Date(Date.now() + 2 * 86_400_000),
        },
      });
    }

    await activityService.record({
      type: 'STATUS_CHANGE', entityType: 'EMPLOYEE', entityId: employeeId,
      title: 'Offboarding started',
      body: `${offboarding.length} task(s) created · ${heldAssets.length} asset(s) to recover`,
    });
    return { offboardingTasks: offboarding.length, assetsToRecover: heldAssets.length };
  },

  // -------------------------------------------------------------- interviews
  async scheduleInterview(dto: z.infer<typeof interviewSchema>) {
    const applicant = await prisma.applicant.findFirst({ where: { id: dto.applicantId } });
    if (!applicant) throw new NotFoundError('Applicant');
    const interview = await prisma.interview.create({
      data: {
        organizationId: orgId(),
        applicantId: dto.applicantId,
        scheduledAt: dto.scheduledAt,
        durationMin: dto.durationMin,
        interviewerId: dto.interviewerId ?? actorMembershipId(),
        mode: dto.mode,
        meetingUrl: dto.meetingUrl ?? null,
      },
    });
    // Scheduling an interview advances the pipeline.
    if (['APPLIED', 'SCREENING'].includes(applicant.stage)) {
      await prisma.applicant.update({ where: { id: dto.applicantId }, data: { stage: 'INTERVIEW' } });
    }
    return interview;
  },

  async recordFeedback(id: string, dto: z.infer<typeof interviewFeedbackSchema>) {
    const interview = await prisma.interview.findFirst({ where: { id } });
    if (!interview) throw new NotFoundError('Interview');
    if (interview.status !== 'SCHEDULED') throw new ConflictError('This interview is already closed');
    return prisma.interview.update({
      where: { id },
      data: {
        status: dto.status,
        feedback: dto.feedback ?? null,
        rating: dto.rating ?? null,
      },
    });
  },

  async upcomingInterviews() {
    return prisma.interview.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
      select: {
        id: true, scheduledAt: true, durationMin: true, mode: true, meetingUrl: true,
        applicant: { select: { id: true, firstName: true, lastName: true, jobPosting: { select: { title: true } } } },
      },
    });
  },
};
