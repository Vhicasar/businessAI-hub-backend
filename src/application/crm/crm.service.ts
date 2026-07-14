import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
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

export const leadStatusSchema = z.object({
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'LOST']),
});

export const dealSchema = z.object({
  title: z.string().trim().min(1).max(200),
  customerId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  value: z.coerce.number().nonnegative().default(0),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  stageId: z.string().optional(), // defaults to first stage
});

export const moveDealSchema = z.object({ stageId: z.string().min(1) });

export const closeDealSchema = z.object({
  outcome: z.enum(['WON', 'LOST']),
  lostReason: z.string().trim().max(300).optional(),
});

export type LeadDto = z.infer<typeof leadSchema>;
export type ListLeadsDto = z.infer<typeof listLeadsSchema>;
export type DealDto = z.infer<typeof dealSchema>;

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
  createdAt: true,
  stage: { select: { id: true, name: true, position: true, isWonStage: true, isLostStage: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  lead: { select: { id: true, firstName: true, lastName: true } },
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

  /** Board: pipeline stages with their open deals + totals. */
  async board() {
    const pipeline = await this.ensureDefaultPipeline();
    const deals = await prisma.deal.findMany({
      where: { pipelineId: pipeline.id, deletedAt: null },
      select: dealSelect,
      orderBy: { createdAt: 'desc' },
    });
    const columns = pipeline.stages.map((stage) => {
      const stageDeals = deals.filter((d) => d.stage.id === stage.id);
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
    const pipeline = await this.ensureDefaultPipeline();
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

    return prisma.deal.create({
      data: {
        title: dto.title,
        pipelineId: pipeline.id,
        stageId: stage.id,
        customerId: dto.customerId ?? null,
        leadId: dto.leadId ?? null,
        value: dto.value,
        currency: org.currency,
        expectedCloseAt: dto.expectedCloseAt ?? null,
      },
      select: dealSelect,
    });
  },

  async moveDeal(dealId: string, stageId: string) {
    const deal = await prisma.deal.findFirst({ where: { id: dealId, deletedAt: null } });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.status !== 'OPEN') throw new ConflictError('Closed deals cannot be moved');
    const stage = await prisma.pipelineStage.findFirst({
      where: { id: stageId, pipelineId: deal.pipelineId },
    });
    if (!stage) throw new NotFoundError('Stage');

    return prisma.deal.update({
      where: { id: dealId },
      data: {
        stageId,
        ...(stage.isWonStage ? { status: 'WON', closedAt: new Date() } : {}),
        ...(stage.isLostStage ? { status: 'LOST', closedAt: new Date() } : {}),
      },
      select: dealSelect,
    });
  },

  async closeDeal(dealId: string, outcome: 'WON' | 'LOST', lostReason?: string) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, deletedAt: null },
      include: { pipeline: { include: { stages: true } } },
    });
    if (!deal) throw new NotFoundError('Deal');
    if (deal.status !== 'OPEN') throw new ConflictError('Deal is already closed');

    const target = deal.pipeline.stages.find((s) =>
      outcome === 'WON' ? s.isWonStage : s.isLostStage
    );
    if (!target) throw new ValidationError(`Pipeline has no ${outcome.toLowerCase()} stage`);

    return prisma.deal.update({
      where: { id: dealId },
      data: {
        status: outcome,
        stageId: target.id,
        closedAt: new Date(),
        ...(outcome === 'LOST' ? { lostReason: lostReason ?? null } : {}),
      },
      select: dealSelect,
    });
  },

  // ------------------------------------------------------------------ leads
  async listLeads(dto: ListLeadsDto) {
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

  async createLead(dto: LeadDto) {
    if (!dto.email && !dto.phone) {
      throw new ValidationError('Provide at least an email or a phone number');
    }
    return prisma.lead.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        source: dto.source ?? null,
        estimatedValue: dto.estimatedValue ?? null,
      },
    });
  },

  async updateLeadStatus(leadId: string, status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'UNQUALIFIED' | 'LOST') {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');
    if (lead.status === 'CONVERTED') throw new ConflictError('Converted leads cannot change status');
    return prisma.lead.update({ where: { id: leadId }, data: { status } });
  },

  /** Converts a lead into a customer (reusing an existing match by email/phone). */
  async convertLead(leadId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');
    if (lead.status === 'CONVERTED') throw new ConflictError('Lead is already converted');

    return prisma.$transaction(async (tx) => {
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
  },
};
