import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { requestContext } from '../../shared/context';
import { activityService } from './activity.service';
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
  leadId: z.string().nullable().optional(),
  value: z.coerce.number().nonnegative().default(0),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  pipelineId: z.string().optional(), // defaults to the default pipeline
  stageId: z.string().optional(), // defaults to first open stage
});

export const stageInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  probability: z.coerce.number().int().min(0).max(100).default(0),
  isWonStage: z.boolean().optional(),
  isLostStage: z.boolean().optional(),
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
    const displayDeals = await Promise.all(deals.map(async (deal) => ({
      ...deal,
      value: (await exchangeRates.convert(Number(deal.value), deal.currency, org.currency)).amount,
      sourceCurrency: deal.currency,
      currency: org.currency,
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
      : pipeline.stages.find((s) => !s.isWonStage && !s.isLostStage);
    if (!stage) throw new NotFoundError('Stage');

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
        ownerId: actorMembershipId(),
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

  async moveDeal(dealId: string, stageId: string) {
    const deal = await prisma.deal.findFirst({ where: { id: dealId, deletedAt: null } });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.status !== 'OPEN') throw new ConflictError('Closed deals cannot be moved');
    const stage = await prisma.pipelineStage.findFirst({
      where: { id: stageId, pipelineId: deal.pipelineId },
    });
    if (!stage) throw new NotFoundError('Stage');
    // Closing a deal must go through the documented-outcome flow (spec #4), not
    // a silent drag onto a won/lost stage.
    if (stage.isWonStage || stage.isLostStage) {
      throw new ValidationError(
        `Use the close flow to mark a deal ${stage.isWonStage ? 'won' : 'lost'} — an outcome reason and summary are required`,
      );
    }

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
    await prisma.pipelineStage.findFirstOrThrow({ where: { id: stageId } });
    return prisma.pipelineStage.update({
      where: { id: stageId },
      data: {
        name: dto.name,
        probability: dto.probability,
        ...(dto.isWonStage !== undefined ? { isWonStage: dto.isWonStage } : {}),
        ...(dto.isLostStage !== undefined ? { isLostStage: dto.isLostStage } : {}),
      },
    });
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

  async createLead(dto: LeadDto, opts: { forceAutoAssign?: boolean } = {}) {
    if (!dto.email && !dto.phone) {
      throw new ValidationError('Provide at least an email or a phone number');
    }
    // Dedupe: never create a second open lead for the same email/phone.
    const duplicate = await prisma.lead.findFirst({
      where: {
        deletedAt: null,
        status: { not: 'CONVERTED' },
        OR: [
          ...(dto.email ? [{ email: dto.email }] : []),
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (duplicate) {
      // Enrich the existing lead with any newly-provided details rather than duplicating.
      const enriched = await prisma.lead.update({
        where: { id: duplicate.id },
        data: {
          lastName: duplicate.lastName ?? dto.lastName ?? null,
          email: duplicate.email ?? dto.email ?? null,
          phone: duplicate.phone ?? dto.phone ?? null,
          estimatedValue: duplicate.estimatedValue ?? dto.estimatedValue ?? null,
        },
      });
      await activityService.record({
        type: 'SYSTEM',
        entityType: 'LEAD',
        entityId: duplicate.id,
        title: `Re-engaged — new inquiry matched this lead`,
        body: dto.source ? `Source: ${dto.source}` : undefined,
        metadata: { source: dto.source ?? 'MANUAL', deduped: true },
      });
      return enriched;
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

  /** Assign (or unassign) an owner to a lead or deal. */
  async assign(entity: 'lead' | 'deal', id: string, ownerId: string | null) {
    if (entity === 'lead') {
      const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
      if (!lead) throw new NotFoundError('Lead');
      const updated = await prisma.lead.update({ where: { id }, data: { ownerId } });
      await activityService.record({
        type: 'SYSTEM', entityType: 'LEAD', entityId: id,
        title: ownerId ? 'Lead reassigned' : 'Lead unassigned',
      });
      return updated;
    }
    const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
    if (!deal) throw new NotFoundError('Deal');
    const updated = await prisma.deal.update({ where: { id }, data: { ownerId }, select: dealSelect });
    await activityService.record({
      type: 'SYSTEM', entityType: 'DEAL', entityId: id,
      title: ownerId ? 'Deal reassigned' : 'Deal unassigned',
    });
    return updated;
  },

  /** Converts a lead into a customer (reusing an existing match by email/phone). */
  async convertLead(leadId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');
    if (lead.status === 'CONVERTED') throw new ConflictError('Lead is already converted');

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
        data: { status: 'CONVERTED', customerId: customer.id, convertedAt: new Date() },
      });
      return { lead: updated, customerId: customer.id };
    });
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'LEAD',
      entityId: leadId,
      title: `Lead converted to customer`,
      also: [{ entityType: 'CUSTOMER', entityId: result.customerId }],
    });
    // After the commit, so the deal links to the customer the conversion just
    // created. Best-effort: a failed automation must not undo the conversion.
    try {
      await this.maybeAutoCreateDeal({ ...result.lead, customerId: result.customerId }, 'converted');
    } catch (e) {
      logger.error({ err: e, leadId }, 'auto deal creation failed after lead conversion');
    }
    return result;
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
      await activityService.record({
        type: 'SYSTEM',
        entityType: 'LEAD',
        entityId: lead.id,
        title: 'Reassigned — SLA breach (no response in time)',
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
    return prisma.note.findMany({
      where: { deletedAt: null, entityType: dto.entityType, entityId: dto.entityId },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
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
