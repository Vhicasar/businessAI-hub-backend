import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { emitToOrg } from '../../infrastructure/realtime/socket';
import { SOCKET_EVENTS } from '../../shared/events';
import { logger } from '../../shared/logger';

/**
 * Staff notifications — persisted (the bell/Notification list) and pushed live
 * over the socket. Used by system paths like the chat bot's handoff/ticket
 * flows, which run outside a normal user request, so everything takes an
 * explicit organizationId.
 */
export interface NotifyInput {
  type: string; // event key, e.g. "inbox.handoff", "ticket.created"
  title: string;
  body?: string;
  data?: Record<string, unknown>; // deep-link payload (conversationId, ticketId…)
}

export const notifyService = {
  /** The signed-in user's recent notifications + unread count (for the tray). */
  async list(userId: string, limit = 30) {
    const [items, unread] = await Promise.all([
      prismaUnscoped.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit }),
      prismaUnscoped.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items, unread };
  },

  async markRead(userId: string, id: string) {
    await prismaUnscoped.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  },

  async markAllRead(userId: string) {
    await prismaUnscoped.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  },

  /** Notify specific users: one Notification row each + a realtime org event. */
  async notifyUsers(orgId: string, userIds: string[], input: NotifyInput): Promise<void> {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return;
    try {
      await prismaUnscoped.notification.createMany({
        data: unique.map((userId) => ({
          organizationId: orgId,
          userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          data: (input.data ?? {}) as object,
        })),
      });
      emitToOrg(orgId, SOCKET_EVENTS.NOTIFICATION_NEW, {
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
      });
    } catch (err) {
      logger.warn({ err, type: input.type }, 'notifyUsers failed');
    }
  },

  /**
   * Notify the right staff for a chat event: the assignee if there is one, else
   * the org's owners, else any active member — so an alert never goes nowhere.
   */
  async notifyStaff(
    orgId: string,
    input: NotifyInput,
    opts: { assigneeMembershipId?: string | null } = {},
  ): Promise<void> {
    let userIds: string[] = [];
    if (opts.assigneeMembershipId) {
      const m = await prismaUnscoped.membership.findFirst({
        where: { id: opts.assigneeMembershipId },
        select: { userId: true },
      });
      if (m) userIds = [m.userId];
    }
    if (userIds.length === 0) {
      const owners = await prismaUnscoped.membership.findMany({
        where: { organizationId: orgId, isActive: true, isOwner: true },
        select: { userId: true },
      });
      userIds = owners.map((o) => o.userId);
    }
    if (userIds.length === 0) {
      const anyMembers = await prismaUnscoped.membership.findMany({
        where: { organizationId: orgId, isActive: true },
        select: { userId: true },
        take: 25,
      });
      userIds = anyMembers.map((a) => a.userId);
    }
    await this.notifyUsers(orgId, userIds, input);
  },
};
