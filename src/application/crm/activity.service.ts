import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';

/**
 * The CRM event backbone. Every module records interactions here so the
 * Unified Activity Timeline is the single source of truth for what happened
 * to a customer, lead, deal, order, invoice, etc.
 *
 * `record()` is best-effort: a failed timeline write must never break the
 * business operation that triggered it, so it swallows and logs errors.
 */

type ActivityType = 'CALL' | 'EMAIL' | 'MEETING' | 'TASK' | 'NOTE' | 'SMS' | 'WHATSAPP' | 'STATUS_CHANGE' | 'SYSTEM';
type EntityType =
  | 'CUSTOMER' | 'LEAD' | 'DEAL' | 'COMPANY' | 'ORDER' | 'PRODUCT' | 'INVOICE' | 'TICKET'
  | 'PROPERTY' | 'CONVERSATION' | 'QUOTATION' | 'CONTRACT' | 'EMPLOYEE' | 'PURCHASE_ORDER'
  | 'LEASE' | 'MAINTENANCE_REQUEST' | 'CAMPAIGN' | 'MEETING';

export interface RecordActivityInput {
  type: ActivityType;
  entityType: EntityType;
  entityId: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  /** Optionally mirror the event onto a second entity (e.g. a deal's customer). */
  also?: { entityType: EntityType; entityId: string }[];
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

export const listTimelineSchema = z.object({
  entityType: z
    .enum([
      'CUSTOMER', 'LEAD', 'DEAL', 'COMPANY', 'ORDER', 'PRODUCT', 'INVOICE', 'TICKET', 'PROPERTY',
      'CONVERSATION', 'QUOTATION', 'CONTRACT', 'EMPLOYEE', 'PURCHASE_ORDER', 'LEASE',
      'MAINTENANCE_REQUEST', 'CAMPAIGN', 'MEETING',
    ])
    .optional(),
  entityId: z.string().optional(),
  /**
   * Filter to what one person *did*, rather than what happened to an entity.
   * (Backed by the Activity_actorUserId_idx index.)
   */
  actorUserId: z.string().optional(),
  type: z.enum(['CALL', 'EMAIL', 'MEETING', 'TASK', 'NOTE', 'SMS', 'WHATSAPP', 'STATUS_CHANGE', 'SYSTEM']).optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListTimelineDto = z.infer<typeof listTimelineSchema>;

const activitySelect = {
  id: true,
  type: true,
  entityType: true,
  entityId: true,
  actorUserId: true,
  title: true,
  body: true,
  metadata: true,
  occurredAt: true,
} as const;

export const activityService = {
  /** Best-effort append to the immutable timeline. Never throws. */
  async record(input: RecordActivityInput): Promise<void> {
    const ctx = requestContext.get();
    if (!ctx?.organizationId) return;
    const targets = [{ entityType: input.entityType, entityId: input.entityId }, ...(input.also ?? [])];
    try {
      await prisma.activity.createMany({
        data: targets.map((t) => ({
          organizationId: ctx.organizationId!,
          type: input.type,
          entityType: t.entityType,
          entityId: t.entityId,
          actorUserId: ctx.userId ?? null,
          title: input.title,
          body: input.body ?? null,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          occurredAt: input.occurredAt ?? new Date(),
        })),
      });
    } catch (err) {
      logger.error({ err, input }, 'activity.record failed');
    }
  },

  /** Timeline for one entity, or an org-wide recent feed when no entity is given. */
  async list(dto: ListTimelineDto) {
    const rows = await prisma.activity.findMany({
      where: {
        organizationId: orgId(),
        ...(dto.entityType ? { entityType: dto.entityType } : {}),
        ...(dto.entityId ? { entityId: dto.entityId } : {}),
        ...(dto.actorUserId ? { actorUserId: dto.actorUserId } : {}),
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.search
          ? {
              OR: [
                { title: { contains: dto.search, mode: 'insensitive' as const } },
                { body: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: activitySelect,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },
};
