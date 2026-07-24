import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { usersService } from '../users/users.service';

/**
 * Turning employees into users. An employee record on its own is just data —
 * it only becomes a person who can sign in, own a lead or approve a request
 * once it's linked to a user account, which is what accepting an invite does.
 *
 * Every entry point previews before it sends: inviting is an outward-facing,
 * irreversible act (real email, real inbox), and a department invite can be
 * dozens of them at once.
 */

/** Guard against a fat-fingered invite to an entire company. */
const MAX_PER_BATCH = 200;

export const inviteEmployeesSchema = z.object({
  roleId: z.string().min(1),
});

/** Why an employee can't be invited, or that they can. */
export type InviteEligibility = 'ready' | 'no_email' | 'already_a_user' | 'invite_pending' | 'not_active';

export interface InviteCandidate {
  employeeId: string;
  employeeNumber: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  eligibility: InviteEligibility;
  /** Human-readable explanation, shown next to the candidate in the UI. */
  reason: string;
}

const REASONS: Record<InviteEligibility, string> = {
  ready: 'Will be emailed an invitation',
  no_email: 'No email address on their record',
  already_a_user: 'Already has an account in this organisation',
  invite_pending: 'Already has an invitation waiting — resending will refresh it',
  not_active: 'Not an active employee',
};

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

const candidateSelect = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  email: true,
  jobTitle: true,
  status: true,
  userId: true,
} as const;

type EmployeeRow = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
  jobTitle: string | null;
  status: string;
  userId: string | null;
};

/**
 * Classify each employee. Pending invites are `ready`-adjacent: we surface them
 * separately so a resend is a conscious choice rather than a silent no-op.
 */
async function classify(rows: EmployeeRow[]): Promise<InviteCandidate[]> {
  const emails = rows.map((r) => r.email).filter((e): e is string => Boolean(e));

  const [members, pending] = await Promise.all([
    emails.length
      ? prisma.membership.findMany({
          where: { deletedAt: null, user: { email: { in: emails } } },
          select: { user: { select: { email: true } } },
        })
      : Promise.resolve([]),
    emails.length
      ? prisma.invitation.findMany({
          where: { email: { in: emails }, acceptedAt: null, expiresAt: { gt: new Date() } },
          select: { email: true },
        })
      : Promise.resolve([]),
  ]);
  const memberEmails = new Set(members.map((m) => m.user.email.toLowerCase()));
  const pendingEmails = new Set(pending.map((p) => p.email.toLowerCase()));

  return rows.map((r) => {
    const email = r.email?.trim().toLowerCase() || null;
    const eligibility: InviteEligibility = !email
      ? 'no_email'
      : r.userId || memberEmails.has(email)
        ? 'already_a_user'
        : r.status !== 'ACTIVE'
          ? 'not_active'
          : pendingEmails.has(email)
            ? 'invite_pending'
            : 'ready';
    return {
      employeeId: r.id,
      employeeNumber: r.employeeNumber,
      name: `${r.firstName} ${r.lastName}`.trim(),
      email,
      jobTitle: r.jobTitle,
      eligibility,
      reason: REASONS[eligibility],
    };
  });
}

/** Pending invites are re-sendable; everything else but `ready` is a no-go. */
const isSendable = (c: InviteCandidate): boolean =>
  c.eligibility === 'ready' || c.eligibility === 'invite_pending';

export const employeeInvitesService = {
  /** Who would be emailed if you invited this department — without sending anything. */
  async previewDepartment(departmentId: string) {
    const dept = await prisma.department.findFirst({
      where: { id: departmentId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!dept) throw new NotFoundError('Department');

    const rows = await prisma.employee.findMany({
      where: { departmentId, deletedAt: null },
      select: candidateSelect,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    const candidates = await classify(rows as EmployeeRow[]);
    return {
      department: dept,
      candidates,
      sendable: candidates.filter(isSendable).length,
      total: candidates.length,
    };
  },

  async previewEmployee(employeeId: string) {
    const row = await prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: candidateSelect,
    });
    if (!row) throw new NotFoundError('Employee');
    const [candidate] = await classify([row as EmployeeRow]);
    return candidate!;
  },

  async inviteEmployee(employeeId: string, roleId: string) {
    const candidate = await this.previewEmployee(employeeId);
    if (!isSendable(candidate)) {
      throw new ValidationError(`Cannot invite ${candidate.name}: ${candidate.reason.toLowerCase()}`);
    }
    await sendOne(candidate, roleId);
    return { invited: 1, skipped: 0, results: [{ ...candidate, outcome: 'invited' as const }] };
  },

  /**
   * Invite everyone in a department who can be invited. Ineligible employees
   * are reported, not failed — one person without an email shouldn't stop the
   * other thirty from being onboarded.
   */
  async inviteDepartment(departmentId: string, roleId: string) {
    const { candidates } = await this.previewDepartment(departmentId);
    const targets = candidates.filter(isSendable);
    if (targets.length === 0) {
      throw new ValidationError('Nobody in this department can be invited right now');
    }
    if (targets.length > MAX_PER_BATCH) {
      throw new ValidationError(
        `That would email ${targets.length} people at once (limit ${MAX_PER_BATCH}). Invite them in smaller groups.`,
      );
    }

    const results: (InviteCandidate & { outcome: 'invited' | 'skipped' | 'failed'; error?: string })[] = [];
    for (const c of candidates) {
      if (!isSendable(c)) {
        results.push({ ...c, outcome: 'skipped' });
        continue;
      }
      try {
        await sendOne(c, roleId);
        results.push({ ...c, outcome: 'invited' });
      } catch (e) {
        // A bounced address shouldn't abort the rest of the department.
        const error = e instanceof Error ? e.message : 'Could not send';
        logger.warn({ err: e, employeeId: c.employeeId }, 'employee invite failed');
        results.push({ ...c, outcome: 'failed', error });
      }
    }
    return {
      invited: results.filter((r) => r.outcome === 'invited').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      results,
    };
  },
};

async function sendOne(candidate: InviteCandidate, roleId: string): Promise<void> {
  // Invitation.invitedById is a *user* id (see users.routes), not a membership.
  const invitedById = requestContext.get()?.userId;
  if (!invitedById) throw new Error('No user in request context');
  await usersService.invite(orgId(), invitedById, {
    email: candidate.email!,
    roleId,
    employeeId: candidate.employeeId,
  });
}
