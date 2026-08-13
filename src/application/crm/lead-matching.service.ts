import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { activityService } from './activity.service';
import { notifyService } from '../notifications/notify.service';

/**
 * Deciding whether a new inquiry is someone the business already knows.
 *
 * The previous behaviour silently folded any inquiry sharing an email or phone
 * into the existing lead and logged "Re-engaged" where nobody would see it. The
 * person entering the lead was never told, and could not say "no, this is a
 * different opportunity".
 *
 * Matching is deliberately graded rather than boolean. An identical email is
 * near-certainly the same person; a shared company name is a hint and nothing
 * more. Presenting those as the same thing is how false duplicates get merged.
 */

export type MatchConfidence = 'EXACT' | 'PROBABLE' | 'POSSIBLE';

export interface LeadMatch {
  leadId: string;
  confidence: MatchConfidence;
  /** Which identifiers agreed — shown to the user so the call is theirs. */
  matchedOn: string[];
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  status: string;
  source: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: Date;
  lastActivityAt: Date | null;
}

export interface MatchCandidateInput {
  firstName?: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyId?: string | null;
  customerId?: string | null;
}

/** Case and spacing are not identity; `John@X.com ` and `john@x.com` are. */
function normalizeEmail(email?: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || null;
}

/**
 * Compare phones by digits alone.
 *
 * "+234 801 234 5678" and "08012345678" are one number written two ways, and
 * treating them as different is how the same person ends up with two leads.
 * The last 9 digits are compared so a country code written inconsistently does
 * not split a match.
 */
function phoneKey(phone?: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

const RANK: Record<MatchConfidence, number> = { EXACT: 3, PROBABLE: 2, POSSIBLE: 1 };

/**
 * Leads that might already be this prospect, strongest first.
 *
 * Only open leads are considered: a lead that was converted or lost is history,
 * and a genuinely new enquiry from the same person is a new opportunity rather
 * than a duplicate.
 */
export async function findLeadMatches(input: MatchCandidateInput): Promise<LeadMatch[]> {
  const email = normalizeEmail(input.email);
  const phone = phoneKey(input.phone);
  const lastName = input.lastName?.trim().toLowerCase() || null;

  // Nothing to match on — a name alone is not an identifier.
  if (!email && !phone && !input.companyId && !input.customerId) return [];

  const candidates = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['CONVERTED', 'LOST', 'UNQUALIFIED'] },
      OR: [
        ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
        // Phone formatting varies, so this is filtered again in memory below.
        ...(input.phone ? [{ phone: { not: null } }] : []),
        ...(input.companyId ? [{ companyId: input.companyId }] : []),
        ...(input.customerId ? [{ customerId: input.customerId }] : []),
      ],
    },
    include: { company: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const matches: LeadMatch[] = [];
  for (const lead of candidates) {
    const matchedOn: string[] = [];
    let confidence: MatchConfidence | null = null;

    if (email && normalizeEmail(lead.email) === email) {
      matchedOn.push('email');
      confidence = 'EXACT';
    }
    if (phone && phoneKey(lead.phone) === phone) {
      matchedOn.push('phone');
      confidence = 'EXACT';
    }
    if (input.customerId && lead.customerId === input.customerId) {
      matchedOn.push('customer');
      confidence = confidence ?? 'EXACT';
    }
    if (input.companyId && lead.companyId === input.companyId) {
      matchedOn.push('company');
      // A shared employer plus a shared surname is a good bet; the company on
      // its own is only worth a look.
      const sameLastName = lastName && lead.lastName?.trim().toLowerCase() === lastName;
      confidence = confidence ?? (sameLastName ? 'PROBABLE' : 'POSSIBLE');
      if (sameLastName) matchedOn.push('surname');
    }
    if (!confidence) continue;

    matches.push({
      leadId: lead.id,
      confidence,
      matchedOn,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      companyName: lead.company?.name ?? null,
      status: lead.status,
      source: lead.source,
      ownerId: lead.ownerId,
      ownerName: null,
      createdAt: lead.createdAt,
      lastActivityAt: null,
    });
  }

  matches.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || +b.createdAt - +a.createdAt);

  // Owner names and last activity are only worth fetching for what is shown.
  const top = matches.slice(0, 5);
  await Promise.all([decorateOwners(top), decorateLastActivity(top)]);
  return top;
}

async function decorateOwners(matches: LeadMatch[]): Promise<void> {
  const ownerIds = [...new Set(matches.map((m) => m.ownerId).filter((id): id is string => !!id))];
  if (!ownerIds.length) return;
  const members = await prisma.membership.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, user: { select: { firstName: true, lastName: true } } },
  });
  const byId = new Map(members.map((m) => [m.id, `${m.user.firstName} ${m.user.lastName ?? ''}`.trim()]));
  for (const match of matches) {
    if (match.ownerId) match.ownerName = byId.get(match.ownerId) ?? null;
  }
}

async function decorateLastActivity(matches: LeadMatch[]): Promise<void> {
  if (!matches.length) return;
  const rows = await prisma.activity.findMany({
    where: { entityType: 'LEAD', entityId: { in: matches.map((m) => m.leadId) } },
    select: { entityId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const seen = new Map<string, Date>();
  for (const row of rows) if (!seen.has(row.entityId)) seen.set(row.entityId, row.createdAt);
  for (const match of matches) match.lastActivityAt = seen.get(match.leadId) ?? null;
}

/**
 * Raised instead of quietly folding an inquiry into an existing lead.
 *
 * Carries the matches so the caller can show them and let the user decide,
 * rather than the server picking on their behalf.
 */
export class DuplicateLeadError extends AppError {
  constructor(public readonly matches: LeadMatch[]) {
    super('DUPLICATE_LEAD', 409, 'This prospect already has an active lead', { matches });
  }
}

export interface ReengageInput {
  leadId: string;
  /** Where the new inquiry came from — WEB_CHAT, WHATSAPP, MANUAL… */
  source?: string | null;
  /** Anything new the inquiry carried, used to fill gaps only. */
  details?: { lastName?: string | null; email?: string | null; phone?: string | null; estimatedValue?: number | null };
  note?: string | null;
  /**
   * Whether to tell the lead's owner. A prospect getting back in touch is worth
   * an interruption; a thousand rows of a spreadsheet import is not.
   */
  notify?: boolean;
}

/**
 * Attach a new inquiry to an existing lead, visibly.
 *
 * Fills only blank fields — an inquiry that arrives with a different phone
 * number must not overwrite the one the business has been calling. The lead's
 * owner is told, because a prospect coming back is exactly the moment someone
 * should pick the conversation up.
 */
export async function reengageLead(input: ReengageInput) {
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId, deletedAt: null } });
  if (!lead) throw new AppError('NOT_FOUND', 404, 'Lead');

  const details = input.details ?? {};
  const updated = await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lastName: lead.lastName ?? details.lastName ?? null,
      email: lead.email ?? details.email ?? null,
      phone: lead.phone ?? details.phone ?? null,
      estimatedValue: lead.estimatedValue ?? details.estimatedValue ?? null,
      reengagedAt: new Date(),
      reengagementCount: { increment: 1 },
    },
  });

  const source = input.source ?? 'MANUAL';
  const actorId = requestContext.get()?.membershipId ?? null;

  await activityService.record({
    type: 'SYSTEM',
    entityType: 'LEAD',
    entityId: lead.id,
    title: 'Lead re-engaged',
    body: [
      'A new inquiry matched this existing lead.',
      `Source: ${source}`,
      input.note?.trim() ? `Note: ${input.note.trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    metadata: {
      source,
      reengagement: true,
      reengagementCount: updated.reengagementCount,
      previous: { reengagedAt: lead.reengagedAt, reengagementCount: lead.reengagementCount },
      next: { reengagedAt: updated.reengagedAt, reengagementCount: updated.reengagementCount },
      actorMembershipId: actorId,
    },
  });

  if (input.notify !== false) {
    await notifyLeadOwner(updated.ownerId, updated.id, updated.firstName, updated.lastName, source);
  }
  return updated;
}

/** Tell whoever owns the lead. Best-effort: a failed notification is not a failed re-engagement. */
async function notifyLeadOwner(
  ownerId: string | null,
  leadId: string,
  firstName: string,
  lastName: string | null,
  source: string
): Promise<void> {
  if (!ownerId) return;
  try {
    const membership = await prisma.membership.findFirst({
      where: { id: ownerId },
      select: { userId: true, organizationId: true },
    });
    if (!membership) return;
    await notifyService.notifyUsers(membership.organizationId, [membership.userId], {
      type: 'crm.lead.reengaged',
      title: `${`${firstName} ${lastName ?? ''}`.trim()} got back in touch`,
      body: `A new inquiry from ${source} matched a lead assigned to you.`,
      data: { leadId, source },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, leadId }, 'lead re-engagement notification not sent');
  }
}
