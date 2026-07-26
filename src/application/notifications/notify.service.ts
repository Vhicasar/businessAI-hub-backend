import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { emitToOrg } from '../../infrastructure/realtime/socket';
import { fcm } from '../../infrastructure/push/fcm';
import { SOCKET_EVENTS } from '../../shared/events';
import { logger } from '../../shared/logger';
import {
  MASTER_KEY,
  NOTIFICATION_TYPES,
  PUSH_PLATFORMS,
  platformKey,
} from '../../shared/notifications';

type PrefRow = { type: string; channel: string; enabled: boolean };

/** enabled unless an explicit row turns it off — so new events default to on. */
function prefAllows(rows: PrefRow[], type: string, channel: 'PUSH' | 'IN_APP' | 'EMAIL'): boolean {
  const row = rows.find((r) => r.type === type && r.channel === channel);
  return row ? row.enabled : true;
}

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
    // Fan out to mobile/web push in the background — never block the caller.
    void this.pushToUsers(unique, input).catch((err) =>
      logger.warn({ err: (err as Error).message, type: input.type }, 'pushToUsers failed'),
    );
  },

  // ---------------------------------------------------------------- devices

  /** Register (or refresh) an FCM device token for the signed-in user. */
  async registerDevice(userId: string, token: string, platform: string) {
    await prismaUnscoped.deviceToken.upsert({
      where: { token },
      update: { userId, platform, updatedAt: new Date() },
      create: { userId, token, platform },
    });
    return { ok: true };
  },

  /** Remove a token (on sign-out or when the browser/app revokes it). */
  async removeDevice(userId: string, token: string) {
    await prismaUnscoped.deviceToken.deleteMany({ where: { token, userId } });
    return { ok: true };
  },

  // ------------------------------------------------------------ preferences

  /**
   * The user's notification settings in a client-ready shape: the master push
   * switch, per-platform push switches, and per-event push/in-app toggles.
   */
  async getPreferences(userId: string) {
    const rows = (await prismaUnscoped.notificationPreference.findMany({
      where: { userId },
      select: { type: true, channel: true, enabled: true },
    })) as PrefRow[];

    return {
      masterPush: prefAllows(rows, MASTER_KEY, 'PUSH'),
      platforms: Object.fromEntries(
        PUSH_PLATFORMS.map((p) => [p, prefAllows(rows, platformKey(p), 'PUSH')]),
      ) as Record<string, boolean>,
      types: NOTIFICATION_TYPES.map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
        push: prefAllows(rows, t.key, 'PUSH'),
        inApp: prefAllows(rows, t.key, 'IN_APP'),
      })),
    };
  },

  /** Upsert a single preference (type + channel → enabled). */
  async setPreference(userId: string, type: string, channel: 'PUSH' | 'IN_APP' | 'EMAIL', enabled: boolean) {
    await prismaUnscoped.notificationPreference.upsert({
      where: { userId_type_channel: { userId, type, channel } },
      update: { enabled },
      create: { userId, type, channel, enabled },
    });
    return { ok: true };
  },

  // ------------------------------------------------------------------ push

  /**
   * Deliver an FCM push to each user's eligible devices, honouring the master
   * switch, the per-event push toggle and the per-platform switch. Dead tokens
   * reported by FCM are pruned.
   */
  async pushToUsers(userIds: string[], input: NotifyInput): Promise<void> {
    if (!fcm.enabled || userIds.length === 0) return;

    const [tokens, prefRows] = await Promise.all([
      prismaUnscoped.deviceToken.findMany({
        where: { userId: { in: userIds } },
        select: { token: true, platform: true, userId: true },
      }),
      prismaUnscoped.notificationPreference.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, type: true, channel: true, enabled: true },
      }),
    ]);
    if (tokens.length === 0) return;

    const byUser = new Map<string, PrefRow[]>();
    for (const r of prefRows) {
      const list = byUser.get(r.userId) ?? [];
      list.push({ type: r.type, channel: r.channel, enabled: r.enabled });
      byUser.set(r.userId, list);
    }

    const eligible = tokens.filter((t) => {
      const rows = byUser.get(t.userId) ?? [];
      return (
        prefAllows(rows, MASTER_KEY, 'PUSH') &&
        prefAllows(rows, input.type, 'PUSH') &&
        prefAllows(rows, platformKey(t.platform), 'PUSH')
      );
    });
    if (eligible.length === 0) return;

    const data: Record<string, string> = { type: input.type };
    for (const [k, v] of Object.entries(input.data ?? {})) data[k] = String(v);

    const result = await fcm.sendToTokens(
      eligible.map((t) => t.token),
      { title: input.title, body: input.body, data },
    );

    if (result.invalidTokens.length) {
      await prismaUnscoped.deviceToken
        .deleteMany({ where: { token: { in: result.invalidTokens } } })
        .catch(() => undefined);
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
