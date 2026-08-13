import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { activityService } from './activity.service';
import { notifyService } from '../notifications/notify.service';
import { mailer } from '../../infrastructure/mail/mailer';

/**
 * Telling someone they now own a lead or a deal.
 *
 * Changing the owner column is a database write; it is not the same as the
 * person finding out. Every path that reassigns work — a person picking a name,
 * an automation, round robin, the load balancer — comes through here so the
 * assignee is actually told and the change is on the record.
 *
 * De-duplicated deliberately: one assignment can fan out into several internal
 * events (the write, the automation that caused it, a status change that
 * triggered the automation), and someone receiving three notifications for one
 * hand-off stops reading them.
 */

export type AssignmentSource =
  | 'MANUAL'
  | 'AUTOMATION'
  | 'ROUND_ROBIN'
  | 'LOAD_BALANCER'
  | 'CONVERSION'
  | 'SLA_REASSIGN';

const SOURCE_LABEL: Record<AssignmentSource, string> = {
  MANUAL: 'Manual assignment',
  AUTOMATION: 'CRM Automation',
  ROUND_ROBIN: 'Round Robin',
  LOAD_BALANCER: 'Load Balancer',
  CONVERSION: 'Lead conversion',
  SLA_REASSIGN: 'SLA reassignment',
};

export interface AssignmentEvent {
  entity: 'lead' | 'deal';
  entityId: string;
  /** Membership ids. Null means unassigned. */
  previousOwnerId: string | null;
  newOwnerId: string | null;
  source: AssignmentSource;
}

/**
 * Assignments already announced, keyed by entity + new owner.
 *
 * In-process and short-lived on purpose: this suppresses the burst of events a
 * single hand-off produces, not a genuine reassignment minutes later. A restart
 * losing the window costs one duplicate notification at worst.
 */
const recentlyNotified = new Map<string, number>();
const DEDUPE_WINDOW_MS = 30_000;

function alreadyNotified(entityId: string, ownerId: string): boolean {
  const key = `${entityId}:${ownerId}`;
  const now = Date.now();
  // Opportunistic sweep — the map only ever holds a handful of live entries.
  for (const [k, at] of recentlyNotified) {
    if (now - at > DEDUPE_WINDOW_MS) recentlyNotified.delete(k);
  }
  const seen = recentlyNotified.get(key);
  if (seen !== undefined && now - seen <= DEDUPE_WINDOW_MS) return true;
  recentlyNotified.set(key, now);
  return false;
}

/** Only exported so tests can start from a clean window. */
export function resetAssignmentDedupe(): void {
  recentlyNotified.clear();
}

interface MemberInfo {
  membershipId: string;
  userId: string;
  organizationId: string;
  name: string;
  email: string;
}

async function memberInfo(membershipId: string | null): Promise<MemberInfo | null> {
  if (!membershipId) return null;
  const row = await prismaUnscoped.membership.findFirst({
    where: { id: membershipId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      user: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!row) return null;
  return {
    membershipId: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    name: `${row.user.firstName} ${row.user.lastName ?? ''}`.trim(),
    email: row.user.email,
  };
}

/** A short human label for the record, e.g. "John Doe" or "ABC Company". */
async function describe(entity: 'lead' | 'deal', entityId: string): Promise<string> {
  if (entity === 'lead') {
    const lead = await prisma.lead.findFirst({
      where: { id: entityId },
      select: { firstName: true, lastName: true },
    });
    return lead ? `${lead.firstName} ${lead.lastName ?? ''}`.trim() : 'Lead';
  }
  const deal = await prisma.deal.findFirst({ where: { id: entityId }, select: { title: true } });
  return deal?.title ?? 'Deal';
}

/**
 * Record the hand-off and tell the new owner.
 *
 * Never throws: an assignment that succeeded must not be reported as failed
 * because a notification could not be delivered. Failures are logged instead.
 */
export async function announceAssignment(event: AssignmentEvent): Promise<void> {
  try {
    const [previous, next, label] = await Promise.all([
      memberInfo(event.previousOwnerId),
      memberInfo(event.newOwnerId),
      describe(event.entity, event.entityId),
    ]);

    const entityLabel = event.entity === 'lead' ? 'Lead' : 'Deal';
    const actorId = requestContext.get()?.membershipId ?? null;
    const actor = actorId ? await memberInfo(actorId) : null;

    // The timeline records every hand-off, including unassignment, and does so
    // whether or not anyone ends up being notified.
    await activityService.record({
      type: 'SYSTEM',
      entityType: event.entity === 'lead' ? 'LEAD' : 'DEAL',
      entityId: event.entityId,
      title: next ? `${entityLabel} assigned to ${next.name}` : `${entityLabel} unassigned`,
      body: [
        `From: ${previous?.name ?? 'Unassigned'}`,
        `To: ${next?.name ?? 'Unassigned'}`,
        `Source: ${SOURCE_LABEL[event.source]}`,
      ].join('\n'),
      metadata: {
        previous: { ownerId: event.previousOwnerId, ownerName: previous?.name ?? null },
        next: { ownerId: event.newOwnerId, ownerName: next?.name ?? null },
        source: event.source,
        sourceLabel: SOURCE_LABEL[event.source],
        // "Assigned by" is the person when there is one, and the system when an
        // automation or a rota did it.
        assignedBy: actor?.name ?? SOURCE_LABEL[event.source],
        assignedByMembershipId: actorId,
      },
    });

    // Nobody to tell: unassignment, or assigning to yourself.
    if (!next) return;
    if (actorId && actorId === next.membershipId) return;
    if (alreadyNotified(event.entityId, next.membershipId)) return;

    await notifyService.notifyUsers(next.organizationId, [next.userId], {
      type: `crm.${event.entity}.assigned`,
      title: `${entityLabel} Assigned`,
      body: `You have been assigned ${entityLabel.toLowerCase()} — ${label}.\nSource: ${SOURCE_LABEL[event.source]}.`,
      data: {
        [`${event.entity}Id`]: event.entityId,
        source: event.source,
        previousOwnerId: event.previousOwnerId,
      },
    });

    await sendAssignmentEmail(next, entityLabel, label, event.source);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, entity: event.entity, entityId: event.entityId },
      'assignment notification not delivered',
    );
  }
}

/**
 * Email as well as the in-app notification, when mail is configured.
 *
 * Best-effort and separately caught: an unreachable SMTP server must not lose
 * the in-app notification that already succeeded.
 */
async function sendAssignmentEmail(
  member: MemberInfo,
  entityLabel: string,
  recordLabel: string,
  source: AssignmentSource,
): Promise<void> {
  try {
    const subject = `${entityLabel} assigned to you — ${recordLabel}`;
    const html =
      `<p>Hello ${member.name},</p>` +
      `<p>You have been assigned ${entityLabel.toLowerCase()} <strong>${recordLabel}</strong>.</p>` +
      `<p>Source: ${SOURCE_LABEL[source]}</p>`;
    const text = `You have been assigned ${entityLabel.toLowerCase()} ${recordLabel}. Source: ${SOURCE_LABEL[source]}`;
    await mailer.sendNotice(member.email, subject, `${entityLabel} assigned`, html, text, {
      organizationId: member.organizationId,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, userId: member.userId }, 'assignment email not sent');
  }
}
