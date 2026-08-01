import { z } from 'zod';
import type { ChannelType } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { resolveEntitlements } from '../billing/entitlements';
import {
  emitToConversation,
  emitToOrg,
} from '../../infrastructure/realtime/socket';
import { SOCKET_EVENTS } from '../../shared/events';
import { getAdapter } from '../../infrastructure/channels/registry';
import { decrypt } from '../../shared/crypto';
import { aiService } from '../ai/ai.service';
import { notifyService } from '../notifications/notify.service';
import type { ChannelAccountRef, NormalizedInbound } from './channel-adapter';

export const listConversationsSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED', 'SPAM']).optional(),
  assigned: z.enum(['me', 'unassigned', 'all']).default('all'),
  channelType: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
});

export type ListConversationsDto = z.infer<typeof listConversationsSchema>;

const conversationListSelect = {
  id: true,
  status: true,
  lastMessageAt: true,
  lastMessageText: true,
  unreadCount: true,
  assignedToId: true,
  aiSentiment: true,
  customer: { select: { id: true, firstName: true, lastName: true } },
  channelAccount: { select: { id: true, name: true, channelType: true } },
} as const;

function toAccountRef(account: {
  id: string;
  organizationId: string;
  externalId: string;
  credentialsEnc: string | null;
  webhookSecret: string | null;
}): ChannelAccountRef {
  return {
    id: account.id,
    organizationId: account.organizationId,
    externalId: account.externalId,
    credentials: account.credentialsEnc
      ? (JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string>)
      : {},
    webhookSecret: account.webhookSecret,
  };
}

export const inboxService = {
  // ---------------------------------------------------------------- inbound

  /**
   * Processes one normalized inbound message:
   * identity find-or-create → customer → conversation → message → realtime.
   * Runs inside requestContext bound to the account's organization.
   */
  async processInbound(
    account: { id: string; organizationId: string; channelType: ChannelType },
    inbound: NormalizedInbound
  ): Promise<void> {
    // Identity resolution: one Customer per human, per-channel handles linked.
    let identity = await prisma.customerIdentity.findFirst({
      where: {
        channelType: account.channelType,
        externalId: inbound.senderExternalId,
      },
      include: { customer: true },
    });

    if (!identity) {
      const displayName = inbound.senderDisplayName ?? `Customer ${inbound.senderExternalId}`;
      const [firstName, ...rest] = displayName.split(' ');
      const senderEmail = account.channelType === 'EMAIL' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inbound.senderExternalId)
        ? inbound.senderExternalId.trim().toLowerCase()
        : null;
      // An email address is a stable customer identity. Reuse a CRM customer
      // that already has it instead of creating a duplicate contact.
      let customer = senderEmail
        ? await prisma.customer.findFirst({ where: { email: senderEmail, deletedAt: null } })
        : null;
      customer ??= await prisma.customer.create({
          data: {
            organizationId: account.organizationId,
            firstName: firstName || 'Unknown',
            lastName: rest.join(' ') || null,
            displayName,
            email: senderEmail,
            isProvisional: account.channelType === 'WEB_CHAT' && /^(website visitor|visitor|guest|anonymous)$/i.test(displayName.trim()),
            lastContactAt: new Date(),
          },
        });
      identity = await prisma.customerIdentity.create({
        data: {
          organizationId: account.organizationId,
          customerId: customer.id,
          channelType: account.channelType,
          externalId: inbound.senderExternalId,
          displayName: inbound.senderDisplayName,
          channelAccountId: account.id,
        },
        include: { customer: true },
      });
    }

    // Backfill contacts created by older versions where the sender address was
    // kept only in CustomerIdentity.externalId.
    if (
      account.channelType === 'EMAIL'
      && !identity.customer.email
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inbound.senderExternalId)
    ) {
      const email = inbound.senderExternalId.trim().toLowerCase();
      await prisma.customer.update({ where: { id: identity.customerId }, data: { email } }).catch((err) =>
        logger.warn({ err, customerId: identity!.customerId, email }, 'Could not backfill email customer address')
      );
      identity.customer.email = email;
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        channelAccountId: account.id,
        customerId: identity.customerId,
        status: { not: 'SPAM' },
      },
      orderBy: { createdAt: 'desc' },
    });
    conversation ??= await prisma.conversation.create({
      data: {
        organizationId: account.organizationId,
        channelAccountId: account.id,
        customerId: identity.customerId,
        status: 'OPEN',
        subject: inbound.subject?.trim() || null,
      },
    });

    // Dedupe on provider message id (webhooks can redeliver).
    const existing = await prisma.message.findFirst({
      where: { conversationId: conversation.id, providerMessageId: inbound.providerMessageId },
    });
    if (existing) return;

    const message = await prisma.message.create({
      data: {
        organizationId: account.organizationId,
        conversationId: conversation.id,
        direction: 'INBOUND',
        authorType: 'CUSTOMER',
        contentType: inbound.contentType,
        body: inbound.text ?? null,
        status: 'DELIVERED',
        providerMessageId: inbound.providerMessageId,
        sentAt: inbound.sentAt ?? new Date(),
      },
    });

    await prisma.$transaction([
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          status: conversation.status === 'RESOLVED' ? 'OPEN' : conversation.status,
          lastMessageAt: message.createdAt,
          lastMessageText: inbound.text?.slice(0, 200) ?? `[${inbound.contentType.toLowerCase()}]`,
          ...(inbound.subject?.trim() ? { subject: inbound.subject.trim() } : {}),
          unreadCount: { increment: 1 },
        },
      }),
      prisma.customer.update({
        where: { id: identity.customerId },
        data: { lastContactAt: new Date() },
      }),
    ]);

    const payload = {
      conversationId: conversation.id,
      message: {
        id: message.id,
        direction: message.direction,
        authorType: message.authorType,
        contentType: message.contentType,
        body: message.body,
        createdAt: message.createdAt,
      },
    };
    emitToOrg(account.organizationId, SOCKET_EVENTS.INBOX_MESSAGE_NEW, payload);
    emitToConversation(conversation.id, SOCKET_EVENTS.INBOX_MESSAGE_NEW, payload);
    logger.debug({ conversationId: conversation.id }, 'Inbound message processed');

    // A visitor starting a session creates a SYSTEM message; notify staff only
    // when there is an actual customer message to read. Chat-message alerts are
    // push-only and deliberately do not add noise to the notification tray.
    if (inbound.contentType !== 'SYSTEM') {
      const senderName = identity.customer.displayName
        || [identity.customer.firstName, identity.customer.lastName].filter(Boolean).join(' ')
        || 'A customer';
      await notifyService.pushChatMessage(
        account.organizationId,
        {
          type: 'inbox.message',
          title: `New message from ${senderName}`,
          body: inbound.text?.trim().slice(0, 180) || `[${inbound.contentType.toLowerCase()}]`,
          data: {
            conversationId: conversation.id,
            channelType: account.channelType,
            link: `/inbox?c=${conversation.id}`,
          },
        },
        { assigneeMembershipId: conversation.assignedToId },
      ).catch((err) => { console.log("Message sending error"); logger.warn({ err, conversationId: conversation.id }, 'Inbound notification failed') });
      console.log("Message sent");
    }

    // Async sentiment (no-op when AI is disabled; never blocks the webhook).
    if (inbound.text) {
      void resolveEntitlements(account.organizationId)
        .then((ent) => ent.features.has('ai_insights')
          ? aiService.analyzeSentiment(conversation.id, inbound.text!)
          : undefined)
        .catch((e) => logger.warn({ err: e }, 'AI sentiment check failed (non-fatal)'));
    }

    // Auto-reply bot (guarded; fire-and-forget).
    if (inbound.text) {
      void this.tryAutoReply(account.id, conversation.id, message.id).catch((e) =>
        logger.warn({ err: e }, 'Auto-reply failed (non-fatal)')
      );
    }
  },

  /**
   * Bot guardrails: account toggle on, AI configured, conversation open and
   * unassigned, prior sentiment not negative, and the triggering message is
   * still the latest (avoids replying over a racing agent/bot message).
   */
  async tryAutoReply(accountId: string, conversationId: string, inboundMessageId: string) {
    const account = await prisma.channelAccount.findFirst({ where: { id: accountId } });
    const autoReply = (account?.metadata as { autoReply?: boolean } | null)?.autoReply;
    if (!account || !autoReply) return;

    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId } });
    if (!conversation || conversation.status !== 'OPEN' || conversation.assignedToId) return;
    // Negative sentiment used to silently drop the bot — which meant an upset
    // customer asking for help or a ticket got nothing. The assistant now handles
    // those by handing off to a human and/or opening a ticket (and notifying
    // staff), so let it run and route them instead of going dark.

    const latest = await prisma.message.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== inboundMessageId) return;

    const reply = await aiService.autoReplyDraft(conversationId);
    if (!reply) return; // handoff or AI disabled — a human takes it

    await this.sendMessage(conversationId, reply, null, 'BOT');
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { isBotHandled: true },
    });
  },

  // --------------------------------------------------------------- outbound

  async sendMessage(
    conversationId: string,
    text: string,
    authorUserId: string | null,
    authorType: 'AGENT' | 'BOT' = 'AGENT'
  ) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      include: {
        channelAccount: true,
        customer: { include: { identities: true } },
      },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    const identity = conversation.customer.identities.find(
      (i) => i.channelType === conversation.channelAccount.channelType
    );
    if (!identity) {
      throw new ConflictError('Customer has no identity on this channel');
    }

    const message = await prisma.message.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId,
        direction: 'OUTBOUND',
        authorType,
        authorUserId,
        aiGenerated: authorType === 'BOT',
        contentType: 'TEXT',
        body: text,
        status: 'QUEUED',
      },
    });

    try {
      const adapter = getAdapter(conversation.channelAccount.channelType);
      const originalSubject = conversation.subject?.trim();
      const replySubject = originalSubject
        ? (/^re\s*:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`)
        : undefined;
      const result = await adapter.sendMessage(
        {
          recipientExternalId: identity.externalId,
          text,
          ...(conversation.channelAccount.channelType === 'EMAIL' && replySubject ? { subject: replySubject } : {}),
        },
        toAccountRef(conversation.channelAccount)
      );
      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date() },
      });
    } catch (e) {
      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'FAILED', errorMessage: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), lastMessageText: text.slice(0, 200) },
    });

    const sent = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    const payload = { conversationId, message: sent };
    emitToOrg(conversation.channelAccount.organizationId, SOCKET_EVENTS.INBOX_MESSAGE_NEW, payload);
    emitToConversation(conversationId, SOCKET_EVENTS.INBOX_MESSAGE_NEW, payload);
    return sent;
  },

  // ------------------------------------------------------------------ reads

  async listConversations(dto: ListConversationsDto, membershipId: string | null) {
    const rows = await prisma.conversation.findMany({
      where: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.assigned === 'me' ? { assignedToId: membershipId } : {}),
        ...(dto.assigned === 'unassigned' ? { assignedToId: null } : {}),
        ...(dto.channelType
          ? { channelAccount: { channelType: dto.channelType as ChannelType } }
          : {}),
        ...(dto.search
          ? {
            OR: [
              { customer: { firstName: { contains: dto.search, mode: 'insensitive' as const } } },
              { customer: { lastName: { contains: dto.search, mode: 'insensitive' as const } } },
              { lastMessageText: { contains: dto.search, mode: 'insensitive' as const } },
            ],
          }
          : {}),
      },
      select: conversationListSelect,
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async getThread(conversationId: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      select: {
        ...conversationListSelect,
        aiSummary: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            lifetimeValue: true,
            totalOrders: true,
            aiSummary: true,
            identities: { select: { channelType: true, externalId: true, displayName: true } },
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            direction: true,
            authorType: true,
            authorUserId: true,
            contentType: true,
            body: true,
            status: true,
            aiGenerated: true,
            errorMessage: true,
            createdAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundError('Conversation');
    return conversation;
  },

  // ---------------------------------------------------------------- actions

  async markRead(conversationId: string) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    });
  },

  /**
   * Unread totals for the inbox badge: the sum across still-active conversations,
   * plus a per-channel breakdown (WhatsApp, Live Chat, Email, …). Tenant-scoped.
   */
  async unreadCounts(): Promise<{ total: number; byChannel: Record<string, number> }> {
    const rows = await prisma.conversation.findMany({
      where: { status: { in: ['OPEN', 'PENDING'] }, unreadCount: { gt: 0 } },
      select: { unreadCount: true, channelAccount: { select: { channelType: true } } },
    });
    let total = 0;
    const byChannel: Record<string, number> = {};
    for (const c of rows) {
      total += c.unreadCount;
      const ch = c.channelAccount.channelType;
      byChannel[ch] = (byChannel[ch] ?? 0) + c.unreadCount;
    }
    return { total, byChannel };
  },

  /**
   * Every communication channel linked to a customer, plus their existing
   * conversations, for the "Chat" action on a customer profile. Tenant-scoped.
   */
  async customerChannels(customerId: string) {
    const [identities, conversations, accounts] = await Promise.all([
      prisma.customerIdentity.findMany({
        where: { customerId },
        select: { channelType: true, displayName: true, externalId: true, channelAccountId: true },
      }),
      prisma.conversation.findMany({
        where: { customerId },
        orderBy: { lastMessageAt: 'desc' },
        select: {
          id: true, status: true, unreadCount: true, lastMessageText: true, lastMessageAt: true,
          channelAccount: { select: { channelType: true, name: true } },
        },
      }),
      prisma.channelAccount.findMany({ select: { channelType: true } }),
    ]);
    const connected = [...new Set(accounts.map((a) => a.channelType))];
    return {
      channels: identities.map((i) => ({
        channelType: i.channelType,
        handle: i.displayName ?? i.externalId,
        connected: connected.includes(i.channelType),
      })),
      connectedChannels: connected,
      conversations: conversations.map((c) => ({
        id: c.id,
        channelType: c.channelAccount.channelType,
        status: c.status,
        unreadCount: c.unreadCount,
        lastMessageText: c.lastMessageText,
        lastMessageAt: c.lastMessageAt,
      })),
    };
  },

  /**
   * Start a new conversation (or continue the latest) with a customer on a
   * given channel and send the first message — from their profile. Reuses the
   * normal outbound path so it lands in the Unified Inbox and CRM timeline.
   */
  async startOrContinue(customerId: string, channelType: ChannelType, text: string, authorUserId: string | null) {
    const identity = await prisma.customerIdentity.findFirst({ where: { customerId, channelType } });
    if (!identity) throw new ConflictError(`This customer has no ${channelType} contact on file`);
    const account = identity.channelAccountId
      ? await prisma.channelAccount.findFirst({ where: { id: identity.channelAccountId } })
      : await prisma.channelAccount.findFirst({ where: { channelType } });
    if (!account) throw new ConflictError(`No connected ${channelType} channel to send from`);

    let convo = await prisma.conversation.findFirst({
      where: { customerId, channelAccountId: account.id },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });
    convo ??= await prisma.conversation.create({
      data: { organizationId: account.organizationId, channelAccountId: account.id, customerId, status: 'OPEN' },
      select: { id: true },
    });
    await this.sendMessage(convo.id, text, authorUserId, 'AGENT');
    return { conversationId: convo.id };
  },

  async assign(conversationId: string, membershipId: string | null) {
    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedToId: membershipId },
      select: conversationListSelect,
    });
    const orgId = requestContext.get()?.organizationId;
    if (orgId) {
      emitToOrg(orgId, SOCKET_EVENTS.INBOX_CONVERSATION_ASSIGNED, {
        conversationId,
        assignedToId: membershipId,
      });
    }
    return updated;
  },

  async setStatus(conversationId: string, status: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED' | 'SPAM') {
    return prisma.conversation.update({
      where: { id: conversationId },
      data: { status, ...(status === 'RESOLVED' ? { closedAt: new Date() } : {}) },
      select: conversationListSelect,
    });
  },
};
