import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';

/**
 * Immutable audit trail for security- and data-sensitive actions
 * (member changes, role changes, logins, exports…). Writes are best-effort;
 * the log is append-only (no update/delete surface).
 */

export interface AuditInput {
  action: string; // e.g. "member.role_changed", "member.removed"
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorType?: 'USER' | 'SYSTEM' | 'API_KEY' | 'AI';
}

export const listAuditSchema = z.object({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(40).optional(),
  actorUserId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type ListAuditDto = z.infer<typeof listAuditSchema>;

export const auditService = {
  /** Append an audit entry. Never throws. */
  async record(input: AuditInput): Promise<void> {
    const ctx = requestContext.get();
    try {
      await prisma.auditLog.create({
        data: {
          organizationId: ctx?.organizationId ?? null,
          actorUserId: ctx?.userId ?? null,
          actorType: input.actorType ?? 'USER',
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      logger.error({ err, action: input.action }, 'audit.record failed');
    }
  },

  /**
   * Audit an action taken by a *customer*, not a workspace user.
   *
   * Super App requests deliberately carry no organization context (a Vhicasar
   * ID spans tenants), so this writes unscoped with organizationId null rather
   * than going through the tenant-scoped client, which would reject the write.
   */
  async recordConsumer(input: AuditInput & { vhicasarId: string; ip?: string; userAgent?: string }): Promise<void> {
    try {
      await prismaUnscoped.auditLog.create({
        data: {
          organizationId: null,
          actorUserId: null,
          actorType: 'USER',
          action: input.action,
          entityType: input.entityType ?? 'VhicasarId',
          entityId: input.entityId ?? input.vhicasarId,
          before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
          ipAddress: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
    } catch (err) {
      logger.error({ err, action: input.action }, 'audit.recordConsumer failed');
    }
  },

  async list(dto: ListAuditDto) {
    const rows = await prisma.auditLog.findMany({
      where: {
        ...(dto.action ? { action: { contains: dto.action, mode: 'insensitive' as const } } : {}),
        ...(dto.entityType ? { entityType: dto.entityType } : {}),
        ...(dto.actorUserId ? { actorUserId: dto.actorUserId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;

    // Resolve actor display names in one query.
    const userIds = [...new Set(items.map((r) => r.actorUserId).filter((x): x is string => Boolean(x)))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
      : [];
    const nameOf = (id: string | null) => {
      if (!id) return 'System';
      const u = users.find((x) => x.id === id);
      return u ? `${u.firstName} ${u.lastName ?? ''}`.trim() || u.email : 'Unknown';
    };

    return {
      items: items.map((r) => ({
        id: r.id,
        action: r.action,
        actorType: r.actorType,
        actorName: nameOf(r.actorUserId),
        entityType: r.entityType,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  },
};
