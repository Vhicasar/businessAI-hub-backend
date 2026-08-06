import type { CustomerNotificationCategory } from '@prisma/client';

import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { consumerPush } from './consumer-push.service';

export interface CustomerNotice {
  vhicasarId: string;
  organizationId?: string | null;
  category: CustomerNotificationCategory;
  title: string;
  body?: string;
  /** Where tapping the notification should land (§14). */
  deeplink?: string;
  data?: Record<string, unknown>;
}

/**
 * Tell a customer something, on every channel that applies (§14).
 *
 * The feed row is written first and is the durable record: push delivery is
 * best-effort and routinely fails (no token, revoked device, FCM outage), and a
 * customer must still be able to find the notification in the app afterwards.
 * Every notice carries a deeplink so the tap lands on the relevant screen.
 */
export async function notifyCustomer(notice: CustomerNotice) {
  const data = { ...(notice.data ?? {}), ...(notice.deeplink ? { deeplink: notice.deeplink } : {}) };

  const row = await prismaUnscoped.customerNotification.create({
    data: {
      vhicasarId: notice.vhicasarId,
      organizationId: notice.organizationId ?? null,
      category: notice.category,
      title: notice.title,
      body: notice.body ?? null,
      data: Object.keys(data).length > 0 ? data : undefined,
    },
  });

  try {
    await consumerPush.sendToIdentity(notice.vhicasarId, {
      title: notice.title,
      body: notice.body ?? '',
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
  } catch (e) {
    // Never let a push failure break the action that triggered it.
    logger.warn({ err: e, vhicasarId: notice.vhicasarId }, 'Consumer push failed; feed row still written');
  }

  return row;
}

export interface BusinessNotice {
  organizationId: string;
  /** Specific users to notify; omit to notify org owners/admins. */
  userIds?: string[];
  title: string;
  body?: string;
  /** Web route the notification opens, e.g. "/settings/settlement". */
  link?: string;
  type?: string;
}

/**
 * Tell the people running a business something (§14).
 *
 * Falls back to owners and admins when no specific recipients are given, so a
 * settlement failure or a bank-account change always reaches someone who can
 * act on it.
 */
export async function notifyBusiness(notice: BusinessNotice) {
  let userIds = notice.userIds ?? [];
  if (userIds.length === 0) {
    // Roles are per-organization rows, not an enum, so owners are found via the
    // membership flag and admins by their role name.
    const memberships = await prismaUnscoped.membership.findMany({
      where: {
        organizationId: notice.organizationId,
        isActive: true,
        deletedAt: null,
        OR: [{ isOwner: true }, { role: { name: { in: ['Owner', 'Admin', 'Administrator'] } } }],
      },
      select: { userId: true },
    });
    userIds = memberships.map((m) => m.userId);
  }
  if (userIds.length === 0) {
    logger.warn({ organizationId: notice.organizationId }, 'No recipient for business notification');
    return [];
  }

  return prismaUnscoped.$transaction(
    userIds.map((userId) =>
      prismaUnscoped.notification.create({
        data: {
          organizationId: notice.organizationId,
          userId,
          type: notice.type ?? 'SYSTEM',
          title: notice.title,
          body: notice.body ?? null,
          data: notice.link ? { link: notice.link } : undefined,
        },
      })
    )
  );
}
