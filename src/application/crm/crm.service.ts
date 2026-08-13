import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { requestContext } from '../../shared/context';
import { activityService } from './activity.service';
import { findLeadMatches, reengageLead, DuplicateLeadError } from './lead-matching.service';
import { announceAssignment, type AssignmentSource } from './assignment-notify.service';
import { workflowService } from './workflow.service';
import { invoicesService } from '../invoices/invoices.service';
import { exchangeRates } from '../../shared/exchange-rates';
import { getAiProvider } from '../../infrastructure/ai';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}

const fullName = (first: string, last?: string | null) => `${first} ${last ?? ''}`.trim();

/**
 * A short AI summary of a lead/deal close for the audit timeline (spec #4).
 * Best-effort: when AI is unavailable it falls back to the human outcome
 * summary, so closing never depends on the AI engine being up.
 */
async function summarizeClose(
  kind: 'deal' | 'lead',
  context: { title: string; outcome: string; reason: string; description?: string; internalNotes?: string; outcomeSummary: string },
): Promise<string> {
  const fallback = context.outcomeSummary;
  const provider = getAiProvider('crm');
  if (!provider) return fallback;
  try {
    const summary = (
      await provider.complete(
        [
          {
            role: 'system',
            content:
              `You write a one- or two-sentence CRM audit summary of why a ${kind} closed. ` +
              'Be factual and neutral; capture the outcome and the key driver. No preamble, no markdown.',
          },
          {
            role: 'user',
            content:
              `${kind === 'deal' ? 'Deal' : 'Lead'}: ${context.title}\nOutcome: ${context.outcome}\n` +
              `Reason: ${context.reason}\n` +
              (context.description ? `Description: ${context.description}\n` : '') +
              (context.internalNotes ? `Internal notes: ${context.internalNotes}\n` : '') +
              `Rep summary: ${context.outcomeSummary}`,
          },
        ],
        { maxTokens: 120, temperature: 0.3 },
      )
    ).trim();
    return summary || fallback;
  } catch (err) {
    logger.info({ err: (err as Error).message, kind }, 'AI close summary skipped');
    return fallback;
  }
}

// ------------------------------------------------------ lead assignment engine

type AssignStrategy = 'ROUND_ROBIN' | 'LOAD_BALANCED' | 'UNASSIGNED';
interface LeadAssignmentConfig {
  strategy: AssignStrategy;
  memberIds: string[];
  slaMinutes: number;
  roundRobinIndex: number;
}
const DEFAULT_ASSIGNMENT: LeadAssignmentConfig = {
  strategy: 'UNASSIGNED',
  memberIds: [],
  slaMinutes: 0,
  roundRobinIndex: 0,
};
const OPEN_LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED'] as const;

async function readAssignment(): Promise<LeadAssignmentConfig> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { settings: true },
  });
  const crm = ((org.settings as Record<string, unknown>) ?? {}).crm as
    | { leadAssignment?: Partial<LeadAssignmentConfig> }
    | undefined;
  return { ...DEFAULT_ASSIGNMENT, ...(crm?.leadAssignment ?? {}) };
}

async function writeAssignment(patch: Partial<LeadAssignmentConfig>): Promise<LeadAssignmentConfig> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { settings: true },
  });
  const settings = (org.settings as Record<string, unknown>) ?? {};
  const crm = (settings.crm as Record<string, unknown>) ?? {};
  const current = { ...DEFAULT_ASSIGNMENT, ...((crm.leadAssignment as object) ?? {}) };
  const next = { ...current, ...patch };
  await prisma.organization.update({
    where: { id: orgId() },
    data: { settings: { ...settings, crm: { ...crm, leadAssignment: next } } },
  });
  return next;
}

/** Pick the next owner per the configured rule, or null if unassigned. */
async function resolveAssignee(cfg?: LeadAssignmentConfig): Promise<string | null> {
  const conf = cfg ?? (await readAssignment());
  if (conf.strategy === 'UNASSIGNED' || conf.memberIds.length === 0) return null;

  const active = await prisma.membership.findMany({
    where: { id: { in: conf.memberIds }, deletedAt: null, isActive: true },
    select: { id: true },
  });
  const activeIds = conf.memberIds.filter((id) => active.some((m) => m.id === id));
  if (activeIds.length === 0) return null;

  if (conf.strategy === 'LOAD_BALANCED') {
    const counts = await prisma.lead.groupBy({
      by: ['ownerId'],
      where: { deletedAt: null, ownerId: { in: activeIds }, status: { in: [...OPEN_LEAD_STATUSES] } },
      _count: { _all: true },
    });
    const countOf = (id: string) => counts.find((c) => c.ownerId === id)?._count._all ?? 0;
    return activeIds.reduce((best, id) => (countOf(id) < countOf(best) ? id : best), activeIds[0] as string);
  }

  // ROUND_ROBIN
  const idx = conf.roundRobinIndex % activeIds.length;
  await writeAssignment({ roundRobinIndex: idx + 1 });
  return activeIds[idx] ?? null;
}

// ------------------------------------------------------------------ schemas

export const leadSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  source: z.string().trim().max(60).nullable().optional(),
  estimatedValue: z.coerce.number().nonnegative().nullable().optional(),
});

export const listLeadsSchema = z.object({
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED', 'LOST']).optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Status has its own endpoint (it drives automation), so it's not editable here. */
export const updateLeadSchema = leadSchema.partial();

export const leadStatusSchema = z.object({
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'LOST']),
  /** Required when transitioning to a terminal status (LOST/UNQUALIFIED); see #4. */
  close: z
    .object({
      reason: z.string().trim().min(3).max(500),
      description: z.string().trim().max(2000).optional(),
      internalNotes: z.string().trim().max(2000).optional(),
      outcomeSummary: z.string().trim().min(3).max(1000),
    })
    .optional(),
});

export const dealSchema = z.object({
  title: z.string().trim().min(1).max(200),
  customerId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  /// Defaults to whoever is acting; set explicitly so a converted deal can
  /// stay with the person who was already working the lead.
  ownerId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  value: z.coerce.number().nonnegative().default(0),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  pipelineId: z.string().optional(), // defaults to the default pipeline
  stageId: z.string().optional(), // defaults to first open stage
});

/**
 * What the user may adjust while confirming a conversion. Every field is
 * optional: the defaults come from the lead, so a plain confirm still works.
 */
export const convertLeadSchema = z.object({
  title: z.string().trim().max(200).optional(),
  value: z.coerce.number().nonnegative().optional(),
  pipelineId: z.string().optional(),
  ownerId: z.string().optional(),
});
export type ConvertLeadDto = z.infer<typeof convertLeadSchema>;

export const stageInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  probability: z.coerce.number().int().min(0).max(100).default(0),
  isWonStage: z.boolean().optional(),
  isLostStage: z.boolean().optional(),
  /// Retiring a stage rather than deleting it keeps the deals already in it.
  isActive: z.boolean().optional(),
});
export const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  module: z.enum(['SALES', 'REAL_ESTATE', 'CUSTOM']).default('CUSTOM'),
  stages: z.array(stageInputSchema).min(1).max(20),
});
export const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isDefault: z.literal(true).optional(),
});
export const reorderStagesSchema = z.object({ stageIds: z.array(z.string().min(1)).min(1) });
export const dealAutomationSchema = z.object({
  onLeadQualified: z.boolean(),
  /** Older clients may not send this; keep their setting off rather than erroring. */
  onLeadConverted: z.boolean().default(false),
  pipelineId: z.string().min(1).nullable().optional(),
  /** Auto-generate an invoice the moment a deal is marked won. */
  autoInvoiceOnWon: z.boolean().default(false),
  /** Net terms (days) for auto-generated deal invoices. */
  invoiceDueDays: z.coerce.number().int().min(0).max(365).default(14),
  /** Mark a deal won automatically once all its linked invoices are fully paid (#10). */
  autoCompleteOnPaid: z.boolean().default(false),
});

export const moveDealSchema = z.object({ stageId: z.string().min(1) });

/**
 * Closing a deal (Won/Lost) requires a documented outcome (spec #4): a reason
 * and a human outcome summary are mandatory; description and internal notes are
 * optional context. `lostReason` is accepted for backward compatibility and, if
 * given without `reason`, seeds it.
 */
export const closeDealSchema = z
  .object({
    outcome: z.enum(['WON', 'LOST']),
    reason: z.string().trim().min(3).max(500).optional(),
    description: z.string().trim().max(2000).optional(),
    internalNotes: z.string().trim().max(2000).optional(),
    outcomeSummary: z.string().trim().min(3).max(1000).optional(),
    lostReason: z.string().trim().max(300).optional(), // legacy alias
  })
  .transform((v) => ({ ...v, reason: v.reason ?? v.lostReason }))
  .refine((v) => Boolean(v.reason), { message: 'A reason is required to close a deal', path: ['reason'] })
  .refine((v) => Boolean(v.outcomeSummary), {
    message: 'An outcome summary is required to close a deal',
    path: ['outcomeSummary'],
  });
export type CloseDealDto = z.infer<typeof closeDealSchema>;

/** Documented outcome required when a lead reaches a terminal status (#4). */
export const closeLeadSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  description: z.string().trim().max(2000).optional(),
  internalNotes: z.string().trim().max(2000).optional(),
  outcomeSummary: z.string().trim().min(3).max(1000),
});
export type CloseLeadDto = z.infer<typeof closeLeadSchema>;

/** Lead statuses that are terminal and therefore need a documented close. */
export const TERMINAL_LEAD_STATUSES = ['LOST', 'UNQUALIFIED'] as const;

const ENTITY_TYPES = [
  'CUSTOMER', 'LEAD', 'DEAL', 'COMPANY', 'ORDER', 'PRODUCT', 'INVOICE', 'TICKET', 'PROPERTY',
  'CONVERSATION', 'QUOTATION', 'CONTRACT', 'EMPLOYEE', 'PURCHASE_ORDER', 'LEASE',
  'MAINTENANCE_REQUEST', 'CAMPAIGN', 'MEETING',
] as const;

export const assignSchema = z.object({ ownerId: z.string().min(1).nullable() });

export const mergeLeadSchema = z.object({ duplicateId: z.string().min(1) });

export const assignmentConfigSchema = z.object({
  strategy: z.enum(['ROUND_ROBIN', 'LOAD_BALANCED', 'UNASSIGNED']),
  memberIds: z.array(z.string().min(1)).max(200),
  slaMinutes: z.coerce.number().int().min(0).max(10080), // up to 7 days
});

export const noteSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1),
  body: z.string().trim().min(1).max(5000),
  isPinned: z.boolean().optional(),
});
export const listNotesSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1),
});

export const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  assigneeId: z.string().min(1).nullable().optional(),
  entityType: z.enum(ENTITY_TYPES).nullable().optional(),
  entityId: z.string().min(1).nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});
export const listTasksSchema = z.object({
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: z.string().optional(),
  assigneeId: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const updateTaskSchema = z.object({
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export type LeadDto = z.infer<typeof leadSchema>;
export type ListLeadsDto = z.infer<typeof listLeadsSchema>;
export type DealDto = z.infer<typeof dealSchema>;
export type NoteDto = z.infer<typeof noteSchema>;
export type ListNotesDto = z.infer<typeof listNotesSchema>;
export type TaskDto = z.infer<typeof taskSchema>;
export type ListTasksDto = z.infer<typeof listTasksSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;

const DEFAULT_STAGES = [
  { name: 'Qualified', position: 1, probability: 20 },
  { name: 'Proposal', position: 2, probability: 45 },
  { name: 'Negotiation', position: 3, probability: 70 },
  { name: 'Won', position: 4, probability: 100, isWonStage: true },
  { name: 'Lost', position: 5, probability: 0, isLostStage: true },
];

const dealSelect = {
  id: true,
  title: true,
  status: true,
  value: true,
  // Sent alongside `value` so a renegotiated deal can show what it opened at.
  originalValue: true,
  currency: true,
  expectedCloseAt: true,
  closedAt: true,
  lostReason: true,
  aiWinProbability: true,
  createdAt: true,
  stage: { select: { id: true, name: true, position: true, isWonStage: true, isLostStage: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  lead: { select: { id: true, firstName: true, lastName: true } },
  invoices: {
    where: { deletedAt: null, status: { not: 'VOID' } },
    select: { id: true, number: true, status: true },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

export const crmService = {
  // ---------------------------------------------------------------- pipeline
  /** Returns the default pipeline with stages, creating it on first use. */
  async ensureDefaultPipeline() {
    const existing = await prisma.pipeline.findFirst({
      where: { isDefault: true },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    if (existing) return existing;
    return prisma.pipeline.create({
      data: {
        organizationId: orgId(),
        name: 'Sales Pipeline',
        isDefault: true,
        stages: { create: DEFAULT_STAGES },
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  },

  /** All pipelines with their stages (for the selector + management UI). */
  async listPipelines() {
    await this.ensureDefaultPipeline();
    const pipelines = await prisma.pipeline.findMany({
      include: { stages: { orderBy: { position: 'asc' } } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    const counts = await prisma.deal.groupBy({
      by: ['pipelineId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      module: p.module,
      isDefault: p.isDefault,
      stages: p.stages,
      dealCount: counts.find((c) => c.pipelineId === p.id)?._count._all ?? 0,
    }));
  },

  /** Board: pipeline stages with their open deals + totals. */
  async board(pipelineId?: string) {
    const pipeline = pipelineId
      ? await prisma.pipeline.findFirstOrThrow({
          where: { id: pipelineId },
          include: { stages: { orderBy: { position: 'asc' } } },
        })
      : await this.ensureDefaultPipeline();
    const deals = await prisma.deal.findMany({
      where: { pipelineId: pipeline.id, deletedAt: null },
      select: dealSelect,
      orderBy: { createdAt: 'desc' },
    });
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { currency: true },
    });
    // Notes are surfaced on the board rather than hidden behind a detail view,
    // so a deal carrying context shows it wherever it sits. Fetched in one
    // grouped query instead of per card.
    const dealIds = deals.map((d) => d.id);
    const notes = dealIds.length
      ? await prisma.note.findMany({
          where: { entityType: 'DEAL', entityId: { in: dealIds }, deletedAt: null },
          select: { entityId: true, body: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const noteCounts = new Map<string, number>();
    const latestNotes = new Map<string, string>();
    for (const note of notes) {
      noteCounts.set(note.entityId, (noteCounts.get(note.entityId) ?? 0) + 1);
      if (!latestNotes.has(note.entityId)) latestNotes.set(note.entityId, note.body);
    }

    const displayDeals = await Promise.all(deals.map(async (deal) => ({
      ...deal,
      value: (await exchangeRates.convert(Number(deal.value), deal.currency, org.currency)).amount,
      sourceCurrency: deal.currency,
      currency: org.currency,
      noteCount: noteCounts.get(deal.id) ?? 0,
      // Trimmed: this is a tooltip, not the note itself.
      latestNote: (latestNotes.get(deal.id) ?? '').slice(0, 160) || null,
    })));
    const columns = pipeline.stages.map((stage) => {
      const stageDeals = displayDeals.filter((d) => d.stage.id === stage.id);
      return {
        stage: {
          id: stage.id,
          name: stage.name,
          position: stage.position,
          probability: stage.probability,
          isWonStage: stage.isWonStage,
          isLostStage: stage.isLostStage,
        },
        deals: stageDeals,
        totalValue: stageDeals.reduce((s, d) => s + Number(d.value), 0),
      };
    });
    return { pipeline: { id: pipeline.id, name: pipeline.name }, columns };
  },

  async createDeal(dto: DealDto) {
    const pipeline = dto.pipelineId
      ? await prisma.pipeline.findFirstOrThrow({
          where: { id: dto.pipelineId },
          include: { stages: { orderBy: { position: 'asc' } } },
        })
      : await this.ensureDefaultPipeline();
    const stage = dto.stageId
      ? pipeline.stages.find((s) => s.id === dto.stageId)
      : // Skip retired stages when picking the opening one, or every new deal
        // would land in a step the business has stopped using.
        pipeline.stages.find((s) => !s.isWonStage && !s.isLostStage && s.isActive);
    if (!stage) throw new NotFoundError('Stage');
    if (!stage.isActive) {
      throw new ConflictError(`“${stage.name}” is disabled, so a deal cannot be created in it`);
    }

    if (dto.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: dto.customerId, deletedAt: null },
      });
      if (!customer) throw new NotFoundError('Customer');
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { currency: true },
    });

    const deal = await prisma.deal.create({
      data: {
        organizationId: orgId(),
        title: dto.title,
        pipelineId: pipeline.id,
        stageId: stage.id,
        customerId: dto.customerId ?? null,
        leadId: dto.leadId ?? null,
        companyId: dto.companyId ?? null,
        // Captured at creation: once a deal is negotiated, `value` no longer
        // says what it was originally worth.
        originalValue: dto.value,
        ownerId: dto.ownerId ?? actorMembershipId(),
        value: dto.value,
        currency: org.currency,
        expectedCloseAt: dto.expectedCloseAt ?? null,
      },
      select: dealSelect,
    });
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'DEAL',
      entityId: deal.id,
      title: `Deal created — ${deal.title}`,
      body: `Opened in “${stage.name}” · ${org.currency} ${Number(deal.value).toFixed(2)}`,
      also: dto.customerId ? [{ entityType: 'CUSTOMER', entityId: dto.customerId }] : undefined,
    });
    await workflowService.dispatch(
      'deal.created',
      { title: deal.title, value: Number(deal.value), stage: stage.name, currency: org.currency },
      { entityType: 'DEAL', entityId: deal.id, customerId: dto.customerId ?? null, ownerId: actorMembershipId() },
    );
    return deal;
  },

  /**
   * Change what a deal is worth, with the reason on the record.
   *
   * A negotiated discount or an added service is a financial fact someone may
   * be asked to justify, so the previous figure is never quietly overwritten —
   * every change keeps what it was, what it became, the difference and why.
   */
  async changeDealValue(dealId: string, newValue: number, reason: string) {
    const deal = await prisma.deal.findFirst({ where: { id: dealId, deletedAt: null } });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.status !== 'OPEN') throw new ConflictError('A closed deal’s value cannot be changed');

    const previous = Number(deal.value);
    if (Math.abs(previous - newValue) < 0.005) {
      throw new ValidationError('The new value is the same as the current one');
    }
    if (!reason.trim()) {
      throw new ValidationError('A reason is required when changing a deal’s value');
    }

    const difference = Number((newValue - previous).toFixed(2));
    const actorId = actorMembershipId();

    const [updated] = await prisma.$transaction([
      prisma.deal.update({
        where: { id: dealId },
        data: {
          value: newValue,
          // Fill the opening figure for deals that predate this being recorded,
          // so their history is not silently rewritten to the new number.
          originalValue: deal.originalValue ?? previous,
        },
        select: dealSelect,
      }),
      prisma.dealValueChange.create({
        data: {
          organizationId: deal.organizationId,
          dealId,
          previousValue: previous,
          newValue,
          difference,
          currency: deal.currency,
          reason: reason.trim(),
          changedById: actorId,
        },
      }),
    ]);

    const sign = difference > 0 ? '+' : '';
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'DEAL',
      entityId: dealId,
      title: `Deal value changed — ${deal.currency} ${newValue.toLocaleString()}`,
      body: [
        `From ${deal.currency} ${previous.toLocaleString()} to ${deal.currency} ${newValue.toLocaleString()}`,
        `Difference: ${sign}${deal.currency} ${difference.toLocaleString()}`,
        `Reason: ${reason.trim()}`,
      ].join('\n'),
      metadata: {
        previous: { value: previous },
        next: { value: newValue },
        difference,
        reason: reason.trim(),
        currency: deal.currency,
        actorMembershipId: actorId,
      },
    });

    return updated;
  },

  /** Every value change on a deal, newest first. */
  async dealValueHistory(dealId: string) {
    const changes = await prisma.dealValueChange.findMany({
      where: { dealId },
      orderBy: { createdAt: 'desc' },
    });
    const memberIds = [...new Set(changes.map((c) => c.changedById).filter((id): id is string => !!id))];
    const members = memberIds.length
      ? await prisma.membership.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, user: { select: { firstName: true, lastName: true } } },
        })
      : [];
    const nameById = new Map(members.map((m) => [m.id, `${m.user.firstName} ${m.user.lastName ?? ''}`.trim()]));
    return changes.map((c) => ({
      ...c,
      changedByName: c.changedById ? nameById.get(c.changedById) ?? null : null,
    }));
  },

  /**
   * What a deal is worth, has been invoiced for, and has been paid.
   *
   * Derived on read rather than stored: invoices and payments change from
   * several directions, and a cached total is a total that goes wrong.
   */
  async dealFinancials(dealId: string) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, deletedAt: null },
      select: { id: true, value: true, originalValue: true, currency: true },
    });
    if (!deal) throw new NotFoundError('Deal');

    const invoices = await prisma.invoice.findMany({
      where: { dealId, deletedAt: null },
      select: {
        id: true, number: true, status: true, total: true, amountPaid: true,
        issuedAt: true, createdAt: true, replacedByInvoiceId: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // A void invoice is history: it is shown, but it is not owed and not counted.
    const live = invoices.filter((i) => i.status !== 'VOID');
    const totalInvoiced = live.reduce((sum, i) => sum + Number(i.total), 0);
    const totalPaid = invoices.reduce((sum, i) => sum + Number(i.amountPaid), 0);

    return {
      dealId: deal.id,
      currency: deal.currency,
      originalValue: Number(deal.originalValue ?? deal.value),
      currentValue: Number(deal.value),
      valueChange: Number(deal.value) - Number(deal.originalValue ?? deal.value),
      totalInvoiced,
      totalPaid,
      outstanding: Number((totalInvoiced - totalPaid).toFixed(2)),
      activeInvoice: live.find((i) => i.status !== 'PAID') ?? live[live.length - 1] ?? null,
      invoices,
    };
  },

  async moveDeal(dealId: string, stageId: string) {
    const deal = await prisma.deal.findFirst({ where: { id: dealId, deletedAt: null } });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.status !== 'OPEN') throw new ConflictError('Closed deals cannot be moved');
    const stage = await prisma.pipelineStage.findFirst({
      where: { id: stageId, pipelineId: deal.pipelineId },
    });
    if (!stage) throw new NotFoundError('Stage');
    // A retired stage is enforced here, not just hidden in the UI: the endpoint
    // is reachable without the board, and a disabled step that still accepts
    // deals is a toggle that does nothing.
    if (!stage.isActive) {
      throw new ConflictError(`“${stage.name}” is disabled, so deals cannot be moved into it`);
    }
    // Closing a deal must go through the documented-outcome flow (spec #4), not
    // a silent drag onto a won/lost stage.
    if (stage.isWonStage || stage.isLostStage) {
      throw new ValidationError(
        `Use the close flow to mark a deal ${stage.isWonStage ? 'won' : 'lost'} — an outcome reason and summary are required`,
      );
    }

    // Read the stage it is leaving before the write, so the record can say what
    // actually changed rather than only where it ended up.
    const fromStage = await prisma.pipelineStage.findFirst({
      where: { id: deal.stageId },
      select: { id: true, name: true },
    });

    const updated = await prisma.deal.update({
      where: { id: dealId },
      data: { stageId },
      select: dealSelect,
    });
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'DEAL',
      entityId: dealId,
      title: `Deal moved to “${stage.name}”`,
      body: fromStage ? `From “${fromStage.name}” to “${stage.name}”.` : undefined,
      metadata: {
        previous: { stageId: fromStage?.id ?? null, stage: fromStage?.name ?? null },
        next: { stageId: stage.id, stage: stage.name },
        actorMembershipId: actorMembershipId(),
      },
      also: updated.customer ? [{ entityType: 'CUSTOMER', entityId: updated.customer.id }] : undefined,
    });
    const wfTarget = {
      entityType: 'DEAL' as const,
      entityId: dealId,
      customerId: updated.customer?.id ?? null,
    };
    const wfPayload = { title: updated.title, value: Number(updated.value), stage: stage.name };
    await workflowService.dispatch('deal.stage_changed', wfPayload, wfTarget);
    if (stage.isWonStage) await workflowService.dispatch('deal.won', wfPayload, wfTarget);
    if (stage.isLostStage) await workflowService.dispatch('deal.lost', wfPayload, wfTarget);
    if (stage.isWonStage) await this.maybeAutoInvoiceDeal(dealId);
    return updated;
  },

  async closeDeal(dealId: string, dto: CloseDealDto) {
    const { outcome, reason, description, internalNotes, outcomeSummary } = dto;
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, deletedAt: null },
      include: { pipeline: { include: { stages: true } }, stage: { select: { name: true } } },
    });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.status !== 'OPEN') throw new ConflictError('Deal is already closed');

    const target = deal.pipeline.stages.find((s) =>
      outcome === 'WON' ? s.isWonStage : s.isLostStage
    );
    if (!target) throw new ValidationError(`Pipeline has no ${outcome.toLowerCase()} stage`);

    // Snapshot the previous values for the audit trail before mutating.
    const previous = { status: deal.status, stageId: deal.stageId, stage: deal.stage?.name ?? null, value: Number(deal.value) };

    const updated = await prisma.deal.update({
      where: { id: dealId },
      data: {
        status: outcome,
        stageId: target.id,
        closedAt: new Date(),
        // Keep the legacy lostReason column populated for LOST closes.
        ...(outcome === 'LOST' ? { lostReason: reason ?? null } : {}),
      },
      select: dealSelect,
    });

    const aiSummary = await summarizeClose('deal', {
      title: updated.title, outcome, reason: reason!, description, internalNotes, outcomeSummary: outcomeSummary!,
    });

    // Full audit record on the timeline: who, before→after, the documented
    // reason/notes/summary and the AI summary (spec #4).
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'DEAL',
      entityId: dealId,
      title: outcome === 'WON' ? `Deal won 🎉 — ${updated.title}` : `Deal lost — ${updated.title}`,
      body: `Reason: ${reason}\nOutcome: ${outcomeSummary}${aiSummary ? `\n\nAI summary: ${aiSummary}` : ''}`,
      metadata: {
        outcome,
        reason,
        description: description ?? null,
        internalNotes: internalNotes ?? null,
        outcomeSummary,
        aiSummary,
        previous,
        next: { status: outcome, stageId: target.id, stage: target.name, value: Number(updated.value) },
      },
      also: updated.customer ? [{ entityType: 'CUSTOMER', entityId: updated.customer.id }] : undefined,
    });
    await workflowService.dispatch(
      outcome === 'WON' ? 'deal.won' : 'deal.lost',
      { title: updated.title, value: Number(updated.value), lostReason: reason ?? '' },
      { entityType: 'DEAL', entityId: dealId, customerId: updated.customer?.id ?? null },
    );
    if (outcome === 'WON') await this.maybeAutoInvoiceDeal(dealId);
    return updated;
  },

  /**
   * When a deal is won and the org has opted in, generate its invoice
   * automatically. Best-effort: a deal with no customer (or one already
   * invoiced) must never block the win itself, so failures are swallowed
   * and logged rather than propagated.
   */
  async maybeAutoInvoiceDeal(dealId: string) {
    let auto;
    try {
      auto = await this.getDealAutomation();
    } catch {
      return;
    }
    if (!auto.autoInvoiceOnWon) return;
    try {
      await invoicesService.createFromDeal(dealId, auto.invoiceDueDays);
    } catch (err) {
      logger.info(
        { dealId, err: err instanceof Error ? err.message : String(err) },
        'auto-invoice on deal won skipped',
      );
    }
  },

  // ------------------------------------------------------- pipeline management
  async createPipeline(dto: z.infer<typeof createPipelineSchema>) {
    const dup = await prisma.pipeline.findFirst({ where: { name: dto.name } });
    if (dup) throw new ConflictError(`A pipeline named "${dto.name}" already exists`);
    return prisma.pipeline.create({
      data: {
        organizationId: orgId(),
        name: dto.name,
        module: dto.module,
        isDefault: false,
        stages: {
          create: dto.stages.map((s, i) => ({
            name: s.name,
            position: i + 1,
            probability: s.probability,
            isWonStage: s.isWonStage ?? false,
            isLostStage: s.isLostStage ?? false,
          })),
        },
      },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  },

  async updatePipeline(id: string, dto: z.infer<typeof updatePipelineSchema>) {
    const pipeline = await prisma.pipeline.findFirstOrThrow({ where: { id } });
    if (dto.name && dto.name !== pipeline.name) {
      const dup = await prisma.pipeline.findFirst({ where: { name: dto.name, id: { not: id } } });
      if (dup) throw new ConflictError(`A pipeline named "${dto.name}" already exists`);
    }
    if (dto.isDefault) {
      await prisma.pipeline.updateMany({ where: {}, data: { isDefault: false } });
    }
    return prisma.pipeline.update({
      where: { id },
      data: { ...(dto.name ? { name: dto.name } : {}), ...(dto.isDefault ? { isDefault: true } : {}) },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
  },

  async deletePipeline(id: string) {
    const pipeline = await prisma.pipeline.findFirstOrThrow({ where: { id } });
    if (pipeline.isDefault) throw new ConflictError('Cannot delete the default pipeline');
    const deals = await prisma.deal.count({ where: { pipelineId: id, deletedAt: null } });
    if (deals > 0) throw new ConflictError('Pipeline has deals — move or close them first');
    await prisma.$transaction([
      prisma.pipelineStage.deleteMany({ where: { pipelineId: id } }),
      prisma.pipeline.deleteMany({ where: { id } }),
    ]);
    return { deleted: true };
  },

  async addStage(pipelineId: string, dto: z.infer<typeof stageInputSchema>) {
    await prisma.pipeline.findFirstOrThrow({ where: { id: pipelineId } });
    const max = await prisma.pipelineStage.aggregate({ where: { pipelineId }, _max: { position: true } });
    return prisma.pipelineStage.create({
      data: {
        pipelineId,
        name: dto.name,
        position: (max._max.position ?? 0) + 1,
        probability: dto.probability,
        isWonStage: dto.isWonStage ?? false,
        isLostStage: dto.isLostStage ?? false,
      },
    });
  },

  async updateStage(stageId: string, dto: z.infer<typeof stageInputSchema>) {
    const before = await prisma.pipelineStage.findFirstOrThrow({ where: { id: stageId } });

    // Refusing to disable the last usable stage: a pipeline with nowhere to put
    // a new deal cannot accept one at all.
    if (dto.isActive === false && before.isActive) {
      const remaining = await prisma.pipelineStage.count({
        where: {
          pipelineId: before.pipelineId,
          isActive: true,
          isWonStage: false,
          isLostStage: false,
          id: { not: stageId },
        },
      });
      if (remaining === 0) {
        throw new ConflictError(
          'This is the only open stage left in the pipeline, so it cannot be disabled',
        );
      }
    }

    const updated = await prisma.pipelineStage.update({
      where: { id: stageId },
      data: {
        name: dto.name,
        probability: dto.probability,
        ...(dto.isWonStage !== undefined ? { isWonStage: dto.isWonStage } : {}),
        ...(dto.isLostStage !== undefined ? { isLostStage: dto.isLostStage } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    if (dto.isActive !== undefined && dto.isActive !== before.isActive) {
      const held = await prisma.deal.count({ where: { stageId, deletedAt: null, status: 'OPEN' } });
      logger.info(
        { stageId, isActive: dto.isActive, dealsInStage: held },
        dto.isActive ? 'pipeline stage re-enabled' : 'pipeline stage disabled',
      );
    }
    return updated;
  },

  async deleteStage(stageId: string) {
    const stage = await prisma.pipelineStage.findFirstOrThrow({ where: { id: stageId } });
    const count = await prisma.pipelineStage.count({ where: { pipelineId: stage.pipelineId } });
    if (count <= 1) throw new ConflictError('A pipeline needs at least one stage');
    const deals = await prisma.deal.count({ where: { stageId, deletedAt: null } });
    if (deals > 0) throw new ConflictError('Stage has deals — move them first');
    await prisma.pipelineStage.delete({ where: { id: stageId } });
    return { deleted: true };
  },

  /** Reorder stages; two-pass to dodge the unique (pipelineId, position) constraint. */
  async reorderStages(pipelineId: string, stageIds: string[]) {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < stageIds.length; i++) {
        await tx.pipelineStage.update({ where: { id: stageIds[i] }, data: { position: -(i + 1) } });
      }
      for (let i = 0; i < stageIds.length; i++) {
        await tx.pipelineStage.update({ where: { id: stageIds[i] }, data: { position: i + 1 } });
      }
    });
    return prisma.pipelineStage.findMany({ where: { pipelineId }, orderBy: { position: 'asc' } });
  },

  // ------------------------------------------------------- deal automation
  async getDealAutomation() {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const crm = ((org.settings as Record<string, unknown>) ?? {}).crm as
      | {
          dealAutomation?: {
            onLeadQualified?: boolean;
            onLeadConverted?: boolean;
            pipelineId?: string | null;
            autoInvoiceOnWon?: boolean;
            invoiceDueDays?: number;
            autoCompleteOnPaid?: boolean;
          };
        }
      | undefined;
    return {
      onLeadQualified: crm?.dealAutomation?.onLeadQualified ?? false,
      // Defaults off: existing orgs must opt in rather than start seeing new
      // deals appear on conversion.
      onLeadConverted: crm?.dealAutomation?.onLeadConverted ?? false,
      pipelineId: crm?.dealAutomation?.pipelineId ?? null,
      autoInvoiceOnWon: crm?.dealAutomation?.autoInvoiceOnWon ?? false,
      invoiceDueDays: crm?.dealAutomation?.invoiceDueDays ?? 14,
      autoCompleteOnPaid: crm?.dealAutomation?.autoCompleteOnPaid ?? false,
    };
  },

  async saveDealAutomation(dto: z.infer<typeof dealAutomationSchema>) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    const crm = (settings.crm as Record<string, unknown>) ?? {};
    const dealAutomation = {
      onLeadQualified: dto.onLeadQualified,
      onLeadConverted: dto.onLeadConverted,
      pipelineId: dto.pipelineId ?? null,
      autoInvoiceOnWon: dto.autoInvoiceOnWon,
      invoiceDueDays: dto.invoiceDueDays,
      autoCompleteOnPaid: dto.autoCompleteOnPaid,
    };
    await prisma.organization.update({
      where: { id: orgId() },
      data: { settings: { ...settings, crm: { ...crm, dealAutomation } } },
    });
    return dealAutomation;
  },

  /**
   * Auto-create a deal from a lead when the matching rule is enabled. The new
   * deal is seeded with the lead's estimated value — that's the whole point of
   * recording one — so a lead with no value produces a deal worth 0.
   */
  async maybeAutoCreateDeal(
    lead: {
      id: string;
      firstName: string;
      lastName: string | null;
      customerId: string | null;
      estimatedValue: unknown;
    },
    trigger: 'qualified' | 'converted',
  ) {
    const auto = await this.getDealAutomation();
    const enabled = trigger === 'qualified' ? auto.onLeadQualified : auto.onLeadConverted;
    if (!enabled) return;
    // Don't stack a second deal on a lead that already has one open — a lead
    // that qualifies and is then converted must not produce two.
    const open = await prisma.deal.count({ where: { leadId: lead.id, deletedAt: null, status: 'OPEN' } });
    if (open > 0) return;
    await this.createDeal({
      title: `${fullName(lead.firstName, lead.lastName)} — opportunity`,
      leadId: lead.id,
      customerId: lead.customerId ?? null,
      value: lead.estimatedValue ? Number(lead.estimatedValue) : 0,
      pipelineId: auto.pipelineId ?? undefined,
    });
  },

  // ------------------------------------------------------------------ leads
  async listLeads(dto: ListLeadsDto) {
    // Opportunistic SLA sweep on the first page — keeps reassignment "automatic"
    // without a background worker (runs in the request's tenant context).
    if (!dto.cursor && !dto.search) {
      try {
        await this.reassignStaleLeads();
      } catch {
        /* best-effort */
      }
    }
    const rows = await prisma.lead.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.search
          ? {
              OR: [
                { firstName: { contains: dto.search, mode: 'insensitive' as const } },
                { lastName: { contains: dto.search, mode: 'insensitive' as const } },
                { email: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        source: true,
        status: true,
        estimatedValue: true,
        aiScore: true,
        ownerId: true,
        customerId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  /**
   * Create a lead, or say what it collided with.
   *
   * `onDuplicate` decides what happens when the prospect is already known:
   *  - `ask` (default) raises DuplicateLeadError carrying the matches, so the
   *    caller can show them and let the user choose. Silently folding the
   *    inquiry into an existing lead is what this replaces.
   *  - `reengage` attaches the inquiry to the matched lead, visibly.
   *  - `create` opens a second lead deliberately.
   *
   * Automated capture (website chat, API) passes `reengage`: there is nobody at
   * a keyboard to ask, and a duplicate lead per inbound message is worse than a
   * re-engagement — but it is now recorded and the owner is notified.
   */
  /** One lead, with what it became — for opening a record directly. */
  async getLead(leadId: string) {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      include: {
        company: { select: { id: true, name: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        // A converted lead should be able to show the deal it became.
        deals: {
          where: { deletedAt: null },
          select: { id: true, title: true, status: true, value: true, currency: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!lead) throw new NotFoundError('Lead');
    return lead;
  },

  async createLead(
    dto: LeadDto,
    opts: {
      forceAutoAssign?: boolean;
      onDuplicate?: 'ask' | 'reengage' | 'create';
      matchedLeadId?: string;
      /** False for bulk imports, which must not notify per row. */
      notifyOnReengage?: boolean;
    } = {},
  ) {
    if (!dto.email && !dto.phone) {
      throw new ValidationError('Provide at least an email or a phone number');
    }

    const onDuplicate = opts.onDuplicate ?? 'ask';
    if (onDuplicate !== 'create') {
      const matches = await findLeadMatches({
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
      });
      // Only a near-certain match short-circuits creation. A shared company is
      // worth showing a person, but must never redirect an automated capture.
      const strong = matches.filter((m) => m.confidence === 'EXACT');
      const target = opts.matchedLeadId
        ? matches.find((m) => m.leadId === opts.matchedLeadId)
        : strong[0];

      if (target && onDuplicate === 'reengage') {
        return reengageLead({
          leadId: target.leadId,
          source: dto.source ?? null,
          notify: opts.notifyOnReengage,
          details: {
            lastName: dto.lastName ?? null,
            email: dto.email ?? null,
            phone: dto.phone ?? null,
            estimatedValue: dto.estimatedValue ?? null,
          },
        });
      }
      if (matches.length && onDuplicate === 'ask') {
        throw new DuplicateLeadError(matches);
      }
    }

    // Integration/website capture routes through the assignment rules; a person
    // entering a lead in the UI keeps it themselves (unless they're not a member).
    const ownerId = opts.forceAutoAssign
      ? await resolveAssignee()
      : (actorMembershipId() ?? (await resolveAssignee()));
    const lead = await prisma.lead.create({
      data: {
        organizationId: orgId(),
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        source: dto.source ?? null,
        ownerId,
        estimatedValue: dto.estimatedValue ?? null,
      },
    });
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'LEAD',
      entityId: lead.id,
      title: `Lead created — ${fullName(lead.firstName, lead.lastName)}`,
      body: lead.source ? `Source: ${lead.source}` : undefined,
      metadata: { source: lead.source ?? 'MANUAL', autoAssigned: !actorMembershipId() && !!ownerId },
    });
    // A lead handed out by the rota lands on someone who was not watching, so
    // they are told. Assigning yourself a lead you just typed in is not news,
    // and `announceAssignment` drops that case.
    if (ownerId) {
      const conf = await readAssignment();
      await announceAssignment({
        entity: 'lead',
        entityId: lead.id,
        previousOwnerId: null,
        newOwnerId: ownerId,
        source:
          actorMembershipId() === ownerId
            ? 'MANUAL'
            : conf.strategy === 'LOAD_BALANCED'
              ? 'LOAD_BALANCER'
              : 'ROUND_ROBIN',
      });
    }
    await workflowService.dispatch(
      'lead.created',
      {
        name: fullName(lead.firstName, lead.lastName),
        source: lead.source ?? 'MANUAL',
        status: lead.status,
        estimatedValue: lead.estimatedValue ? Number(lead.estimatedValue) : 0,
        hasEmail: Boolean(lead.email),
        hasPhone: Boolean(lead.phone),
      },
      { entityType: 'LEAD', entityId: lead.id, ownerId },
    );
    return lead;
  },

  /**
   * Edit a lead's details. Notably the place an estimated value gets set, which
   * is what seeds the value of any deal opened from this lead.
   */
  async updateLead(leadId: string, dto: z.infer<typeof updateLeadSchema>) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');

    const updated = await prisma.lead.update({
      where: { id: leadId },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.source !== undefined ? { source: dto.source } : {}),
        ...(dto.estimatedValue !== undefined ? { estimatedValue: dto.estimatedValue } : {}),
      },
    });

    const before = Number(lead.estimatedValue ?? 0);
    const after = Number(updated.estimatedValue ?? 0);
    if (dto.estimatedValue !== undefined && before !== after) {
      // Worth its own timeline entry: it changes the value of deals opened later.
      await activityService.record({
        type: 'SYSTEM',
        entityType: 'LEAD',
        entityId: leadId,
        title: `Lead value updated — ${after.toLocaleString()}`,
        also: lead.customerId ? [{ entityType: 'CUSTOMER', entityId: lead.customerId }] : undefined,
      });
    }
    return updated;
  },

  async updateLeadStatus(
    leadId: string,
    status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'UNQUALIFIED' | 'LOST',
    close?: CloseLeadDto,
  ) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');
    if (lead.status === 'CONVERTED') throw new ConflictError('Converted leads cannot change status');

    // Terminal statuses need a documented outcome (spec #4).
    const isTerminal = (TERMINAL_LEAD_STATUSES as readonly string[]).includes(status);
    if (isTerminal && !close) {
      throw new ValidationError(`Marking a lead ${status.toLowerCase()} requires a reason and outcome summary`);
    }

    const previous = { status: lead.status };
    const updated = await prisma.lead.update({ where: { id: leadId }, data: { status } });

    const aiSummary =
      isTerminal && close
        ? await summarizeClose('lead', {
            title: fullName(lead.firstName, lead.lastName),
            outcome: status,
            reason: close.reason,
            description: close.description,
            internalNotes: close.internalNotes,
            outcomeSummary: close.outcomeSummary,
          })
        : null;

    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'LEAD',
      entityId: leadId,
      title: `Lead status → ${status.toLowerCase()}`,
      body: close ? `Reason: ${close.reason}\nOutcome: ${close.outcomeSummary}${aiSummary ? `\n\nAI summary: ${aiSummary}` : ''}` : undefined,
      metadata: close
        ? {
            status,
            reason: close.reason,
            description: close.description ?? null,
            internalNotes: close.internalNotes ?? null,
            outcomeSummary: close.outcomeSummary,
            aiSummary,
            previous,
            next: { status },
          }
        : { previous, next: { status } },
      also: lead.customerId ? [{ entityType: 'CUSTOMER', entityId: lead.customerId }] : undefined,
    });
    const wfTarget = {
      entityType: 'LEAD' as const,
      entityId: leadId,
      customerId: lead.customerId,
      ownerId: lead.ownerId,
    };
    const wfPayload = {
      name: fullName(lead.firstName, lead.lastName),
      status,
      source: lead.source ?? 'MANUAL',
      estimatedValue: lead.estimatedValue ? Number(lead.estimatedValue) : 0,
    };
    await workflowService.dispatch('lead.status_changed', wfPayload, wfTarget);
    if (status === 'QUALIFIED') {
      await this.maybeAutoCreateDeal(lead, 'qualified');
      await workflowService.dispatch('lead.qualified', wfPayload, wfTarget);
    }
    return updated;
  },

  /**
   * Assign (or unassign) an owner to a lead or deal.
   *
   * The single place ownership changes, whoever decided it. `announceAssignment`
   * writes the timeline entry and tells the new owner — changing the column
   * without that is how work used to land on someone silently.
   */
  async assign(
    entity: 'lead' | 'deal',
    id: string,
    ownerId: string | null,
    source: AssignmentSource = 'MANUAL',
  ) {
    if (entity === 'lead') {
      const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
      if (!lead) throw new NotFoundError('Lead');
      // Nothing changed — do not announce a hand-off that did not happen.
      if (lead.ownerId === ownerId) return lead;
      const updated = await prisma.lead.update({ where: { id }, data: { ownerId } });
      await announceAssignment({
        entity: 'lead', entityId: id,
        previousOwnerId: lead.ownerId, newOwnerId: ownerId, source,
      });
      return updated;
    }
    const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.ownerId === ownerId) {
      return prisma.deal.findFirstOrThrow({ where: { id }, select: dealSelect });
    }
    const updated = await prisma.deal.update({ where: { id }, data: { ownerId }, select: dealSelect });
    await announceAssignment({
      entity: 'deal', entityId: id,
      previousOwnerId: deal.ownerId, newOwnerId: ownerId, source,
    });
    return updated;
  },

  /**
   * Turns a lead into a deal.
   *
   * Conversion means an opportunity now exists, so it creates one: previously
   * this only made a Customer and flipped the status, and the deal appeared
   * solely when an off-by-default automation toggle was on — which is why
   * pressing Convert looked like it did nothing.
   *
   * The lead itself is never deleted or emptied. It keeps its source, dates,
   * activities, notes, owner, tags and custom fields, and gains the record of
   * what it became and who decided that.
   */
  async convertLead(leadId: string, dto: ConvertLeadDto = {}) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');
    if (lead.status === 'CONVERTED') throw new ConflictError('Lead is already converted');

    const auto = await this.getDealAutomation();
    const pipelineId = dto.pipelineId ?? auto.pipelineId ?? undefined;
    const actorId = actorMembershipId();

    // Customer and lead move together: a lead marked converted with no customer
    // behind it is a broken record, not a partial success.
    const result = await prisma.$transaction(async (tx) => {
      let customer = await tx.customer.findFirst({
        where: {
          deletedAt: null,
          OR: [
            ...(lead.email ? [{ email: lead.email }] : []),
            ...(lead.phone ? [{ phone: lead.phone }] : []),
          ],
        },
      });
      customer ??= await tx.customer.create({
        data: {
          organizationId: lead.organizationId,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
        },
      });
      const updated = await tx.lead.update({
        where: { id: leadId },
        data: {
          status: 'CONVERTED',
          customerId: customer.id,
          convertedAt: new Date(),
          convertedById: actorId,
        },
      });
      return { lead: updated, customerId: customer.id };
    });

    // An existing open deal on this lead is the opportunity — converting again
    // must not stack a second one beside it.
    const existing = await prisma.deal.findFirst({
      where: { leadId, deletedAt: null, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
    });

    const deal =
      existing ??
      (await this.createDeal({
        title: dto.title?.trim() || `${fullName(lead.firstName, lead.lastName)} — opportunity`,
        leadId,
        customerId: result.customerId,
        companyId: lead.companyId ?? undefined,
        ownerId: dto.ownerId ?? lead.ownerId ?? undefined,
        value: dto.value ?? (lead.estimatedValue ? Number(lead.estimatedValue) : 0),
        pipelineId,
      }));

    // Point the lead at what it became, so the record reads both ways.
    const linked = await prisma.lead.update({
      where: { id: leadId },
      data: { convertedDealId: deal.id },
    });

    await activityService.record({
      type: 'SYSTEM',
      entityType: 'LEAD',
      entityId: leadId,
      title: `Lead converted to deal — ${deal.title}`,
      body: [
        `Deal: ${deal.title}`,
        existing ? 'Linked to the deal already open on this lead.' : 'New deal created.',
        `Customer: ${fullName(lead.firstName, lead.lastName)}`,
      ].join('\n'),
      metadata: {
        previous: { status: lead.status },
        next: { status: 'CONVERTED' },
        dealId: deal.id,
        customerId: result.customerId,
        source: lead.source ?? null,
      },
      also: [
        { entityType: 'CUSTOMER', entityId: result.customerId },
        { entityType: 'DEAL', entityId: deal.id },
      ],
    });

    return { lead: linked, customerId: result.customerId, deal, dealCreated: !existing };
  },

  /** Members eligible for lead/deal ownership (active memberships). */
  async listMembers() {
    const rows = await prisma.membership.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      name: fullName(m.user.firstName, m.user.lastName) || m.user.email,
      email: m.user.email,
    }));
  },

  async getAssignmentConfig() {
    const { roundRobinIndex: _omit, ...cfg } = await readAssignment();
    return cfg;
  },

  async saveAssignmentConfig(dto: { strategy: AssignStrategy; memberIds: string[]; slaMinutes: number }) {
    // Reset the rotation cursor when the roster changes so round-robin stays fair.
    return writeAssignment({ ...dto, roundRobinIndex: 0 });
  },

  /** Merge a duplicate lead into a primary — moves deals, keeps the primary. */
  async mergeLeads(primaryId: string, duplicateId: string) {
    if (primaryId === duplicateId) throw new ValidationError('Cannot merge a lead into itself');
    const [primary, duplicate] = await Promise.all([
      prisma.lead.findFirst({ where: { id: primaryId, deletedAt: null } }),
      prisma.lead.findFirst({ where: { id: duplicateId, deletedAt: null } }),
    ]);
    if (!primary) throw new NotFoundError('Primary lead');
    if (!duplicate) throw new NotFoundError('Duplicate lead');

    const merged = await prisma.$transaction(async (tx) => {
      await tx.deal.updateMany({ where: { leadId: duplicateId }, data: { leadId: primaryId } });
      const updated = await tx.lead.update({
        where: { id: primaryId },
        data: {
          lastName: primary.lastName ?? duplicate.lastName,
          email: primary.email ?? duplicate.email,
          phone: primary.phone ?? duplicate.phone,
          estimatedValue: primary.estimatedValue ?? duplicate.estimatedValue,
        },
      });
      await tx.lead.update({
        where: { id: duplicateId },
        data: { deletedAt: new Date(), status: 'UNQUALIFIED' },
      });
      return updated;
    });
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'LEAD',
      entityId: primaryId,
      title: `Merged duplicate lead — ${fullName(duplicate.firstName, duplicate.lastName)}`,
    });
    return merged;
  },

  /**
   * Reassign leads that breached the SLA (still NEW past the window) to the next
   * owner per the configured rule. Returns how many were reassigned.
   */
  async reassignStaleLeads() {
    const cfg = await readAssignment();
    if (cfg.strategy === 'UNASSIGNED' || cfg.slaMinutes <= 0 || cfg.memberIds.length === 0) {
      return { reassigned: 0 };
    }
    const cutoff = new Date(Date.now() - cfg.slaMinutes * 60_000);
    const stale = await prisma.lead.findMany({
      where: { deletedAt: null, status: 'NEW', createdAt: { lt: cutoff } },
      select: { id: true, ownerId: true, firstName: true, lastName: true, customerId: true },
      take: 50,
    });
    let reassigned = 0;
    for (const lead of stale) {
      const next = await resolveAssignee(cfg);
      if (!next || next === lead.ownerId) continue;
      await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: next } });
      await announceAssignment({
        entity: 'lead',
        entityId: lead.id,
        previousOwnerId: lead.ownerId,
        newOwnerId: next,
        source: 'SLA_REASSIGN',
      });
      reassigned += 1;
    }
    return { reassigned };
  },

  // ------------------------------------------------------------------ notes
  async createNote(dto: NoteDto) {
    const note = await prisma.note.create({
      data: {
        organizationId: orgId(),
        entityType: dto.entityType,
        entityId: dto.entityId,
        authorUserId: requestContext.get()?.userId ?? null,
        body: dto.body,
        isPinned: dto.isPinned ?? false,
      },
    });
    await activityService.record({
      type: 'NOTE',
      entityType: dto.entityType,
      entityId: dto.entityId,
      title: 'Note added',
      body: dto.body,
    });
    return note;
  },

  async listNotes(dto: ListNotesDto) {
    const notes = await prisma.note.findMany({
      where: { deletedAt: null, entityType: dto.entityType, entityId: dto.entityId },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });

    // "Sarah" reads better than a user id, and the note list is the one place
    // authorship actually matters.
    const authorIds = [...new Set(notes.map((n) => n.authorUserId).filter((id): id is string => !!id))];
    const authors = authorIds.length
      ? await prismaUnscoped.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const nameById = new Map(authors.map((a) => [a.id, `${a.firstName} ${a.lastName ?? ''}`.trim()]));

    const viewerId = requestContext.get()?.userId ?? null;
    return notes.map((note) => ({
      ...note,
      authorName: note.authorUserId ? nameById.get(note.authorUserId) ?? null : null,
      /** Whether this note has been edited since it was written. */
      edited: note.updatedAt.getTime() - note.createdAt.getTime() > 1000,
      isOwn: Boolean(viewerId && note.authorUserId === viewerId),
    }));
  },

  /**
   * Edit a note.
   *
   * Anyone may correct their own; changing someone else's is a separate
   * permission, checked here rather than only at the route, because a note is
   * a record of what a colleague observed.
   */
  async updateNote(noteId: string, body: string, canEditOthers = false) {
    const note = await prisma.note.findFirst({ where: { id: noteId, deletedAt: null } });
    if (!note) throw new NotFoundError('Note');

    const viewerId = requestContext.get()?.userId ?? null;
    const isOwn = Boolean(viewerId && note.authorUserId === viewerId);
    if (!isOwn && !canEditOthers) {
      throw new ForbiddenError('You can only edit your own notes');
    }

    const updated = await prisma.note.update({ where: { id: noteId }, data: { body } });
    await activityService.record({
      type: 'NOTE',
      entityType: note.entityType,
      entityId: note.entityId,
      title: 'Note edited',
      body,
      metadata: { noteId, previous: { body: note.body }, next: { body } },
    });
    return updated;
  },

  /** Soft-delete a note, so the timeline still shows that it existed. */
  async deleteNote(noteId: string, canDeleteOthers = false) {
    const note = await prisma.note.findFirst({ where: { id: noteId, deletedAt: null } });
    if (!note) throw new NotFoundError('Note');

    const viewerId = requestContext.get()?.userId ?? null;
    const isOwn = Boolean(viewerId && note.authorUserId === viewerId);
    if (!isOwn && !canDeleteOthers) {
      throw new ForbiddenError('You can only delete your own notes');
    }

    await prisma.note.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
    await activityService.record({
      type: 'NOTE',
      entityType: note.entityType,
      entityId: note.entityId,
      title: 'Note deleted',
      metadata: { noteId, previous: { body: note.body } },
    });
    return { ok: true };
  },

  // ------------------------------------------------------------------ tasks
  async createTask(dto: TaskDto) {
    const task = await prisma.task.create({
      data: {
        organizationId: orgId(),
        title: dto.title,
        description: dto.description ?? null,
        priority: dto.priority,
        assigneeId: dto.assigneeId ?? actorMembershipId(),
        createdById: actorMembershipId(),
        entityType: dto.entityType ?? null,
        entityId: dto.entityId ?? null,
        dueAt: dto.dueAt ?? null,
      },
    });
    if (dto.entityType && dto.entityId) {
      await activityService.record({
        type: 'TASK',
        entityType: dto.entityType,
        entityId: dto.entityId,
        title: `Task created — ${dto.title}`,
        body: dto.dueAt ? `Due ${dto.dueAt.toDateString()}` : undefined,
      });
    }
    return task;
  },

  async listTasks(dto: ListTasksDto) {
    const rows = await prisma.task.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.entityType ? { entityType: dto.entityType } : {}),
        ...(dto.entityId ? { entityId: dto.entityId } : {}),
        ...(dto.mine ? { assigneeId: actorMembershipId() } : dto.assigneeId ? { assigneeId: dto.assigneeId } : {}),
      },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async updateTask(id: string, dto: UpdateTaskDto) {
    const task = await prisma.task.findFirst({ where: { id, deletedAt: null } });
    if (!task) throw new NotFoundError('Task');
    const completing = dto.status === 'DONE' && task.status !== 'DONE';
    const updated = await prisma.task.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
        ...(dto.dueAt !== undefined ? { dueAt: dto.dueAt } : {}),
        ...(completing ? { completedAt: new Date() } : {}),
      },
    });
    if (completing && task.entityType && task.entityId) {
      await activityService.record({
        type: 'TASK',
        entityType: task.entityType as NoteDto['entityType'],
        entityId: task.entityId,
        title: `Task completed — ${updated.title}`,
      });
    }
    return updated;
  },
};
