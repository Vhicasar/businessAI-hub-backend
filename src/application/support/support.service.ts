import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { activityService } from '../crm/activity.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}

const STATUSES = ['OPEN', 'PENDING', 'ON_HOLD', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

// Default SLA windows (hours) for first response / resolution, by priority.
function slaFor(priority: string): { firstResponse: number; resolution: number } {
  switch (priority) {
    case 'URGENT': return { firstResponse: 1, resolution: 8 };
    case 'HIGH': return { firstResponse: 4, resolution: 24 };
    case 'LOW': return { firstResponse: 24, resolution: 72 };
    default: return { firstResponse: 8, resolution: 48 };
  }
}
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const listTicketsSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  customerId: z.string().min(1),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  assigneeId: z.string().min(1).nullable().optional(),
});
export const updateTicketSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  satisfactionScore: z.coerce.number().int().min(1).max(5).optional(), // CSAT
  npsScore: z.coerce.number().int().min(0).max(10).optional(), // NPS
  cesScore: z.coerce.number().int().min(1).max(7).optional(), // CES
});
export const commentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  isInternal: z.boolean().default(false),
});
export const slaPolicySchema = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.enum(PRIORITIES),
  firstResponseMinutes: z.coerce.number().int().min(1).max(100_000),
  resolutionMinutes: z.coerce.number().int().min(1).max(1_000_000),
  businessHoursOnly: z.boolean().default(true),
});
export const routingConfigSchema = z.object({
  strategy: z.enum(['ROUND_ROBIN', 'LOAD_BALANCED', 'UNASSIGNED']),
  memberIds: z.array(z.string().min(1)).max(200),
  autoEscalateOnBreach: z.boolean().default(true),
});

// ------------------------------------------------------------ routing engine

type RoutingStrategy = 'ROUND_ROBIN' | 'LOAD_BALANCED' | 'UNASSIGNED';
interface RoutingConfig {
  strategy: RoutingStrategy;
  memberIds: string[];
  autoEscalateOnBreach: boolean;
  roundRobinIndex: number;
}
const DEFAULT_ROUTING: RoutingConfig = {
  strategy: 'UNASSIGNED',
  memberIds: [],
  autoEscalateOnBreach: true,
  roundRobinIndex: 0,
};
const OPEN_TICKET_STATUSES = ['OPEN', 'PENDING', 'ON_HOLD', 'ESCALATED'] as const;

async function readRouting(): Promise<RoutingConfig> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { settings: true },
  });
  const support = ((org.settings as Record<string, unknown>) ?? {}).support as
    | { routing?: Partial<RoutingConfig> }
    | undefined;
  return { ...DEFAULT_ROUTING, ...(support?.routing ?? {}) };
}

async function writeRouting(patch: Partial<RoutingConfig>): Promise<RoutingConfig> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { settings: true },
  });
  const settings = (org.settings as Record<string, unknown>) ?? {};
  const support = (settings.support as Record<string, unknown>) ?? {};
  const current = { ...DEFAULT_ROUTING, ...((support.routing as object) ?? {}) };
  const next = { ...current, ...patch };
  await prisma.organization.update({
    where: { id: orgId() },
    data: { settings: { ...settings, support: { ...support, routing: next } } },
  });
  return next;
}

/** Pick the next agent per the configured rule, or null when unassigned. */
async function routeToAgent(cfg?: RoutingConfig): Promise<string | null> {
  const conf = cfg ?? (await readRouting());
  if (conf.strategy === 'UNASSIGNED' || conf.memberIds.length === 0) return null;

  const active = await prisma.membership.findMany({
    where: { id: { in: conf.memberIds }, deletedAt: null, isActive: true },
    select: { id: true },
  });
  const activeIds = conf.memberIds.filter((id) => active.some((m) => m.id === id));
  if (activeIds.length === 0) return null;

  if (conf.strategy === 'LOAD_BALANCED') {
    const counts = await prisma.ticket.groupBy({
      by: ['assigneeId'],
      where: { deletedAt: null, assigneeId: { in: activeIds }, status: { in: [...OPEN_TICKET_STATUSES] } },
      _count: { _all: true },
    });
    const countOf = (id: string) => counts.find((c) => c.assigneeId === id)?._count._all ?? 0;
    return activeIds.reduce((best, id) => (countOf(id) < countOf(best) ? id : best), activeIds[0] as string);
  }

  const idx = conf.roundRobinIndex % activeIds.length;
  await writeRouting({ roundRobinIndex: idx + 1 });
  return activeIds[idx] ?? null;
}

const ticketSelect = {
  id: true, number: true, subject: true, description: true, status: true, priority: true,
  assigneeId: true, firstResponseDueAt: true, resolutionDueAt: true, firstRespondedAt: true,
  resolvedAt: true, closedAt: true, escalatedAt: true,
  satisfactionScore: true, npsScore: true, cesScore: true, createdAt: true,
  customer: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

type TicketRow = { status: string; resolutionDueAt: Date | null };
/** SLA breach is derived — open ticket past its resolution due date. */
function withSla<T extends TicketRow>(t: T): T & { slaBreached: boolean } {
  const slaBreached =
    !['RESOLVED', 'CLOSED'].includes(t.status) && t.resolutionDueAt !== null && t.resolutionDueAt < new Date();
  return { ...t, slaBreached };
}

async function nextNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.ticket.count({ where: { number: { startsWith: `TKT-${year}-` } } });
  return `TKT-${year}-${String(count + 1).padStart(5, '0')}`;
}

export const supportService = {
  async list(dto: z.infer<typeof listTicketsSchema>) {
    // Opportunistic SLA-breach sweep on the first page — keeps escalation
    // automatic without a background worker (runs in the request's tenant context).
    if (!dto.cursor && !dto.search) {
      try {
        await this.escalateOverdue();
      } catch {
        /* best-effort */
      }
    }
    const rows = await prisma.ticket.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.mine ? { assigneeId: actorMembershipId() } : dto.assigneeId ? { assigneeId: dto.assigneeId } : {}),
        ...(dto.search
          ? {
              OR: [
                { number: { contains: dto.search, mode: 'insensitive' as const } },
                { subject: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: ticketSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = (hasMore ? rows.slice(0, dto.limit) : rows).map(withSla);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async get(id: string) {
    const ticket = await prisma.ticket.findFirst({ where: { id, deletedAt: null }, select: ticketSelect });
    if (!ticket) throw new NotFoundError('Ticket');
    const comments = await this.listComments(id);
    return { ...withSla(ticket), comments };
  },

  async listComments(ticketId: string) {
    return prisma.ticketComment.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, authorType: true, authorUserId: true, body: true, isInternal: true, createdAt: true },
    });
  },

  /** Post a reply or internal note to a ticket. First public reply meets first-response SLA. */
  async addComment(ticketId: string, dto: z.infer<typeof commentSchema>) {
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: ticketSelect });
    if (!ticket) throw new NotFoundError('Ticket');

    const comment = await prisma.ticketComment.create({
      data: {
        organizationId: orgId(),
        ticketId,
        authorType: 'AGENT',
        authorUserId: requestContext.get()?.userId ?? null,
        body: dto.body,
        isInternal: dto.isInternal,
      },
      select: { id: true, authorType: true, authorUserId: true, body: true, isInternal: true, createdAt: true },
    });

    // A public agent reply satisfies first response and advances an open ticket.
    if (!dto.isInternal) {
      const patch: Record<string, unknown> = {};
      if (ticket.firstRespondedAt === null) patch.firstRespondedAt = new Date();
      if (ticket.status === 'OPEN') patch.status = 'PENDING';
      if (Object.keys(patch).length) await prisma.ticket.update({ where: { id: ticketId }, data: patch });

      // Deliver the reply back to the customer on the chat the ticket came from,
      // so answering a ticket actually reaches them. Lazy import avoids the
      // inbox↔support module cycle; a delivery failure must not fail the reply.
      const link = await prisma.ticket.findFirst({ where: { id: ticketId }, select: { conversationId: true } });
      if (link?.conversationId) {
        try {
          const { inboxService } = await import('../inbox/inbox.service');
          await inboxService.sendMessage(link.conversationId, dto.body, requestContext.get()?.userId ?? null, 'AGENT');
        } catch (err) {
          logger.warn({ err, ticketId }, 'Ticket reply → conversation delivery failed');
        }
      }
    }

    await activityService.record({
      type: dto.isInternal ? 'NOTE' : 'EMAIL',
      entityType: 'TICKET',
      entityId: ticketId,
      title: dto.isInternal ? 'Internal note added' : 'Agent replied',
      body: dto.body,
      also: [{ entityType: 'CUSTOMER', entityId: ticket.customer.id }],
    });
    return comment;
  },

  async create(dto: z.infer<typeof createTicketSchema>, opts: { conversationId?: string; autoRoute?: boolean } = {}) {
    const customer = await prisma.customer.findFirst({ where: { id: dto.customerId, deletedAt: null } });
    if (!customer) throw new NotFoundError('Customer');

    // A configured SLA policy for this priority wins over the built-in defaults.
    const policy = await prisma.slaPolicy.findFirst({ where: { priority: dto.priority } });
    const fallback = slaFor(dto.priority);
    const firstResponseMs = policy ? policy.firstResponseMinutes * MINUTE : fallback.firstResponse * HOUR;
    const resolutionMs = policy ? policy.resolutionMinutes * MINUTE : fallback.resolution * HOUR;
    const now = Date.now();

    // Explicit assignee > routing rules > the creating agent (for manual entry).
    const routed = await routeToAgent();
    const assigneeId = dto.assigneeId ?? routed ?? (opts.autoRoute ? null : actorMembershipId());

    const ticket = await prisma.ticket.create({
      data: {
        organizationId: orgId(),
        number: await nextNumber(),
        subject: dto.subject,
        description: dto.description ?? null,
        customerId: dto.customerId,
        conversationId: opts.conversationId ?? null,
        priority: dto.priority,
        status: 'OPEN',
        assigneeId,
        slaPolicyId: policy?.id ?? null,
        firstResponseDueAt: new Date(now + firstResponseMs),
        resolutionDueAt: new Date(now + resolutionMs),
      },
      select: ticketSelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'TICKET', entityId: ticket.id,
      title: `Ticket opened — ${ticket.subject}`,
      body: `${ticket.number} · ${dto.priority.toLowerCase()} priority${policy ? ` · SLA “${policy.name}”` : ''}${routed && !dto.assigneeId ? ' · auto-routed' : ''}`,
      also: [{ entityType: 'CUSTOMER', entityId: dto.customerId }],
    });
    return withSla(ticket);
  },

  /**
   * Turn an inbox conversation into a ticket, reusing the AI summary/sentiment
   * the inbox already computed (negative sentiment raises priority).
   */
  async createFromConversation(conversationId: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      select: { id: true, customerId: true, subject: true, lastMessageText: true, aiSummary: true, aiSentiment: true },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    // Never open a second ticket for the same conversation.
    const existing = await prisma.ticket.findFirst({
      where: { conversationId, deletedAt: null, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      select: ticketSelect,
    });
    if (existing) {
      const comments = await this.listComments(existing.id);
      return { ...withSla(existing), comments, deduped: true };
    }

    const subject = conversation.subject?.trim() || conversation.lastMessageText?.slice(0, 120).trim() || 'Support request';
    const priority = conversation.aiSentiment === 'NEGATIVE' ? 'HIGH' : 'MEDIUM';
    const created = await this.create(
      {
        subject,
        description: conversation.aiSummary ?? conversation.lastMessageText ?? null,
        customerId: conversation.customerId,
        priority,
      },
      { conversationId, autoRoute: true },
    );
    const comments = await this.listComments(created.id);
    return { ...created, comments, deduped: false };
  },

  // ------------------------------------------------------------ SLA policies
  async listSlaPolicies() {
    return prisma.slaPolicy.findMany({ orderBy: { priority: 'asc' } });
  },
  async createSlaPolicy(dto: z.infer<typeof slaPolicySchema>) {
    const dup = await prisma.slaPolicy.findFirst({ where: { name: dto.name } });
    if (dup) throw new ConflictError(`An SLA policy named "${dto.name}" already exists`);
    return prisma.slaPolicy.create({ data: { organizationId: orgId(), ...dto } });
  },
  async updateSlaPolicy(id: string, dto: z.infer<typeof slaPolicySchema>) {
    const existing = await prisma.slaPolicy.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('SLA policy');
    return prisma.slaPolicy.update({ where: { id }, data: dto });
  },
  async deleteSlaPolicy(id: string) {
    const existing = await prisma.slaPolicy.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('SLA policy');
    await prisma.slaPolicy.deleteMany({ where: { id } });
    return { deleted: true };
  },

  /** Agents eligible for ticket assignment (active memberships). */
  async listMembers() {
    const rows = await prisma.membership.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      name: `${m.user.firstName} ${m.user.lastName ?? ''}`.trim() || m.user.email,
      email: m.user.email,
    }));
  },

  // ------------------------------------------------------- routing config
  async getRouting() {
    const { roundRobinIndex: _omit, ...cfg } = await readRouting();
    return cfg;
  },
  async saveRouting(dto: z.infer<typeof routingConfigSchema>) {
    return writeRouting({ ...dto, roundRobinIndex: 0 });
  },

  /** Escalate tickets that blew their resolution SLA. Returns how many. */
  async escalateOverdue() {
    const cfg = await readRouting();
    if (!cfg.autoEscalateOnBreach) return { escalated: 0 };
    const overdue = await prisma.ticket.findMany({
      where: {
        deletedAt: null,
        status: { in: ['OPEN', 'PENDING', 'ON_HOLD'] },
        resolutionDueAt: { lt: new Date() },
      },
      select: { id: true, number: true, customerId: true, priority: true },
      take: 50,
    });
    for (const t of overdue) {
      await prisma.ticket.update({
        where: { id: t.id },
        data: { status: 'ESCALATED', escalatedAt: new Date(), priority: t.priority === 'URGENT' ? 'URGENT' : 'HIGH' },
      });
      await activityService.record({
        type: 'SYSTEM', entityType: 'TICKET', entityId: t.id,
        title: `Auto-escalated — resolution SLA breached (${t.number})`,
        also: [{ entityType: 'CUSTOMER', entityId: t.customerId }],
      });
    }
    return { escalated: overdue.length };
  },

  async update(id: string, dto: z.infer<typeof updateTicketSchema>) {
    const ticket = await prisma.ticket.findFirst({ where: { id, deletedAt: null }, select: ticketSelect });
    if (!ticket) throw new NotFoundError('Ticket');

    const now = new Date();
    const statusChanged = dto.status && dto.status !== ticket.status;
    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
        ...(dto.satisfactionScore !== undefined ? { satisfactionScore: dto.satisfactionScore } : {}),
        ...(dto.npsScore !== undefined ? { npsScore: dto.npsScore } : {}),
        ...(dto.cesScore !== undefined ? { cesScore: dto.cesScore } : {}),
        // Track SLA-relevant timestamps.
        ...(ticket.firstRespondedAt === null && dto.status === 'PENDING' ? { firstRespondedAt: now } : {}),
        ...(dto.status === 'RESOLVED' ? { resolvedAt: now } : {}),
        ...(dto.status === 'CLOSED' ? { closedAt: now } : {}),
      },
      select: ticketSelect,
    });
    if (statusChanged) {
      await activityService.record({
        type: 'STATUS_CHANGE', entityType: 'TICKET', entityId: id,
        title: `Ticket → ${dto.status!.toLowerCase().replace(/_/g, ' ')}`,
        also: [{ entityType: 'CUSTOMER', entityId: ticket.customer.id }],
      });
    }
    return withSla(updated);
  },

  async escalate(id: string, note?: string) {
    const ticket = await prisma.ticket.findFirst({ where: { id, deletedAt: null }, select: ticketSelect });
    if (!ticket) throw new NotFoundError('Ticket');
    if (['RESOLVED', 'CLOSED'].includes(ticket.status)) throw new ConflictError('Ticket is already closed');
    const updated = await prisma.ticket.update({
      where: { id },
      data: { status: 'ESCALATED', escalatedAt: new Date(), priority: ticket.priority === 'URGENT' ? 'URGENT' : 'HIGH' },
      select: ticketSelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'TICKET', entityId: id,
      title: 'Ticket escalated', body: note,
      also: [{ entityType: 'CUSTOMER', entityId: ticket.customer.id }],
    });
    return withSla(updated);
  },
};
