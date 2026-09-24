import { z } from 'zod';
import { Prisma, type ChannelType, type Customer } from '@prisma/client';
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
import type {
  ChannelAccountRef,
  NormalizedInbound,
  NormalizedStatus,
} from './channel-adapter';
import { ingestInboundMedia } from './inbox-media.service';
import { markChannelConnected, markChannelError, markOutboundMessageSent } from './channel-health.service';
import { workflowService } from '../crm/workflow.service';

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
  customer: {
    select: {
      id: true, firstName: true, lastName: true, displayName: true,
      identities: { select: { channelType: true, displayName: true, profileUrl: true } },
    },
  },
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

/** Capture an explicitly stated visitor name without depending on an AI reply. */
function statedName(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\b(?:my name is|i am|i'm)\s+([\p{L}][\p{L}'-]{1,49})(?:\s+([\p{L}][\p{L}'-]{1,49}))?/iu);
  if (!match?.[1]) return null;
  const first = match[1];
  const notNames = new Set([
    'interested', 'looking', 'trying', 'writing', 'contacting', 'ready', 'happy',
    'sorry', 'here', 'calling', 'asking', 'reaching',
  ]);
  if (notNames.has(first.toLowerCase())) return null;
  return [first, match[2]].filter(Boolean).join(' ');
}

function usefulName(value: string | null | undefined): string | null {
  const name = value?.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!name || /^[^\s@]+@[^\s@]+$/.test(name) || /^\+?\d{6,}$/.test(name)) return null;
  if (/^(customer|contact|user)\s+[a-z0-9_.:-]+$/i.test(name)) return null;
  return name;
}

function placeholderCustomer(customer: Pick<Customer, 'firstName' | 'displayName' | 'isProvisional'>): boolean {
  const name = customer.displayName || customer.firstName;
  return customer.isProvisional
    || !usefulName(name)
    || /^(unknown|website visitor|visitor|guest|anonymous)$/i.test(name.trim())
    || /^(?:[a-z_ ]+\s+)?(?:contact|customer|user)(?:\s*\([^)]*\))?$/i.test(name.trim());
}

function contactPhone(value: string | undefined): string | null {
  const phone = value?.trim();
  if (!phone) return null;
  if (/^\d{7,15}$/.test(phone)) return `+${phone}`;
  return /^\+\d{7,15}$/.test(phone) ? phone : null;
}

async function syncInboundCustomerProfile(
  identity: { id: string; customerId: string; displayName: string | null; profileUrl: string | null; customer: Customer },
  channelType: ChannelType,
  inbound: NormalizedInbound,
): Promise<void> {
  const profile = inbound.senderProfile;
  const enrichment = inbound.profileEnrichment;
  const structured = usefulName([profile?.firstName, profile?.lastName].filter(Boolean).join(' '));
  const displayName = structured || usefulName(inbound.senderDisplayName) || usefulName(profile?.username ? `@${profile.username}` : null);
  const split = displayName?.replace(/^@/, '').split(/\s+/) ?? [];
  const shouldReplaceName = Boolean(displayName && placeholderCustomer(identity.customer));
  const email = profile?.email?.trim().toLowerCase();
  const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  const phone = contactPhone(profile?.phone);
  const oldCustom = identity.customer.customFields && typeof identity.customer.customFields === 'object' && !Array.isArray(identity.customer.customFields)
    ? identity.customer.customFields as Record<string, unknown> : {};
  const oldProfiles = oldCustom.channelProfiles && typeof oldCustom.channelProfiles === 'object' && !Array.isArray(oldCustom.channelProfiles)
    ? oldCustom.channelProfiles as Record<string, unknown> : {};
  const channelProfile = Object.fromEntries(Object.entries({
    firstName: profile?.firstName?.trim() || undefined,
    lastName: profile?.lastName?.trim() || undefined,
    username: profile?.username || undefined,
    displayName: displayName || undefined,
    profileUrl: profile?.profileUrl || undefined,
    sources: Object.fromEntries(Object.entries({
      name: displayName ? channelType : undefined,
      username: profile?.username ? channelType : undefined,
      profileUrl: profile?.profileUrl ? channelType : undefined,
      email: validEmail ? channelType : undefined,
      phone: phone ? channelType : undefined,
    }).filter(([, value]) => value !== undefined)),
    ...(enrichment?.status === 'SKIPPED' ? {} : { updatedAt: new Date().toISOString() }),
    enrichment: enrichment && enrichment.status !== 'SKIPPED' ? {
      status: enrichment.status,
      reason: enrichment.reason,
      permissionSufficient: enrichment.permissionSufficient,
      advancedAccessRequired: enrichment.advancedAccessRequired,
      attemptedAt: enrichment.attemptedAt,
      fields: {
        name: Boolean(structured || usefulName(inbound.senderDisplayName)),
        username: Boolean(profile?.username),
        profilePicture: Boolean(profile?.profileUrl),
        email: Boolean(validEmail),
        phone: Boolean(phone),
      },
    } : undefined,
  }).filter(([, value]) => value !== undefined));

  if (displayName || profile?.profileUrl) {
    await prisma.customerIdentity.update({
      where: { id: identity.id },
      data: {
        ...(displayName ? { displayName } : {}),
        ...(profile?.profileUrl ? { profileUrl: profile.profileUrl } : {}),
      },
    });
  }
  const updated = await prisma.customer.update({
      where: { id: identity.customerId },
      data: {
        ...(shouldReplaceName ? {
          firstName: profile?.firstName?.trim().slice(0, 80) || split[0] || 'Unknown',
          lastName: profile?.lastName?.trim().slice(0, 80) || split.slice(1).join(' ') || null,
          displayName,
          isProvisional: false,
        } : {}),
        ...((Object.keys(channelProfile).length > 0) ? {
          customFields: {
            ...oldCustom,
            channelProfiles: {
              ...oldProfiles,
              [channelType]: { ...((oldProfiles[channelType] as object | undefined) ?? {}), ...channelProfile },
            },
          } as Prisma.InputJsonValue,
        } : {}),
        lastContactAt: new Date(),
      },
    });
  identity.customer = updated;
  identity.displayName = displayName || identity.displayName;
  identity.profileUrl = profile?.profileUrl || identity.profileUrl;
  if (enrichment) {
    logger.info({
      customerId: identity.customerId,
      channelType,
      profileEnrichment: enrichment.status,
      reason: enrichment.reason,
      nameAvailable: Boolean(structured || usefulName(inbound.senderDisplayName)),
      usernameAvailable: Boolean(profile?.username),
      profilePictureAvailable: Boolean(profile?.profileUrl),
      emailAvailable: Boolean(validEmail),
      phoneAvailable: Boolean(phone),
      permissionSufficient: enrichment.permissionSufficient,
      advancedAccessRequired: enrichment.advancedAccessRequired,
    }, 'Inbound customer profile enrichment');
  }
  for (const data of [
    !updated.email && validEmail ? { email: validEmail } : null,
    !updated.phone && phone ? { phone } : null,
  ].filter((value): value is { email: string } | { phone: string } => Boolean(value))) {
    await prisma.customer.update({ where: { id: identity.customerId }, data }).then((customer) => { identity.customer = customer; }).catch((error) => {
      // That address belongs to another CRM record. Keep the name/profile and
      // message rather than failing the webhook.
      logger.warn({ error, customerId: identity.customerId, channelType, field: 'email' in data ? 'email' : 'phone' }, 'Could not backfill inbound customer contact field');
    });
  }
}

/**
 * Delivery states in the order they can only ever move forwards through.
 *
 * Receipts arrive out of order — a read receipt can overtake the delivery one
 * on a busy connection — and a message that went from READ back to DELIVERED
 * would look to an agent like the customer un-read it.
 */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3,
  // Failure is terminal and can arrive at any point, so it outranks the rest.
  FAILED: 4,
};

export const inboxService = {
  // ---------------------------------------------------------------- inbound

  /**
   * Processes one normalized inbound message:
   * identity find-or-create → customer → conversation → message → realtime.
   * Runs inside requestContext bound to the account's organization.
   */
  /**
   * Move an outbound message along from a provider receipt.
   *
   * Idempotent and monotonic: replaying a webhook changes nothing, and a
   * receipt that arrives after a later one is ignored rather than winding the
   * message back.
   */
  async applyStatus(
    account: { id: string; organizationId: string },
    update: NormalizedStatus
  ): Promise<void> {
    const message = await prisma.message.findFirst({
      where: {
        organizationId: account.organizationId,
        providerMessageId: update.providerMessageId,
        direction: 'OUTBOUND',
      },
      select: { id: true, status: true, conversationId: true },
    });
    // A receipt for something we never sent — an echo of an inbound message,
    // or a message from before this account was connected.
    if (!message) return;

    const current = STATUS_RANK[message.status] ?? 0;
    const next = STATUS_RANK[update.status] ?? 0;
    if (next <= current) return;

    const at = update.occurredAt ?? new Date();
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: update.status,
        ...(update.status === 'DELIVERED' ? { deliveredAt: at } : {}),
        ...(update.status === 'READ' ? { readAt: at, deliveredAt: at } : {}),
        ...(update.status === 'FAILED' ? { errorMessage: update.error ?? 'Delivery failed' } : {}),
      },
    });

    const payload = {
      messageId: message.id,
      conversationId: message.conversationId,
      status: update.status,
      at: at.toISOString(),
      ...(update.status === 'FAILED' ? { error: update.error ?? null } : {}),
    };
    emitToOrg(account.organizationId, SOCKET_EVENTS.INBOX_MESSAGE_STATUS, payload);
    emitToConversation(message.conversationId, SOCKET_EVENTS.INBOX_MESSAGE_STATUS, payload);
  },

  async processInbound(
    account: { id: string; organizationId: string; channelType: ChannelType },
    inbound: NormalizedInbound
  ): Promise<'PERSISTED' | 'DUPLICATE'> {
    // Identity resolution: one Customer per human, per-channel handles linked.
    let identity = await prisma.customerIdentity.findFirst({
      where: {
        channelType: account.channelType,
        externalId: inbound.senderExternalId,
      },
      include: { customer: true },
    });

    if (!identity) {
      const profileName = [inbound.senderProfile?.firstName, inbound.senderProfile?.lastName].filter(Boolean).join(' ');
      const resolvedName = usefulName(profileName) || usefulName(inbound.senderDisplayName) || usefulName(inbound.senderProfile?.username ? `@${inbound.senderProfile.username}` : null);
      const displayName = resolvedName || `${account.channelType.replace(/_/g, ' ')} contact`;
      const [firstName, ...rest] = displayName.split(' ');
      const senderEmail = account.channelType === 'EMAIL' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inbound.senderExternalId)
        ? inbound.senderExternalId.trim().toLowerCase()
        : inbound.senderProfile?.email?.trim().toLowerCase() ?? null;
      const senderPhone = contactPhone(inbound.senderProfile?.phone);
      // Stable email/phone identities reuse an existing CRM contact instead
      // of creating a second customer for the same person.
      let customer = senderEmail || senderPhone
        ? await prisma.customer.findFirst({
            where: { deletedAt: null, OR: [...(senderEmail ? [{ email: senderEmail }] : []), ...(senderPhone ? [{ phone: senderPhone }] : [])] },
          })
        : null;
      customer ??= await prisma.customer.create({
          data: {
            organizationId: account.organizationId,
            firstName: firstName || 'Unknown',
            lastName: rest.join(' ') || null,
            displayName,
            email: senderEmail,
            phone: senderPhone,
            isProvisional: !resolvedName,
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

    await syncInboundCustomerProfile(identity, account.channelType, inbound);

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
    const isNewConversation = !conversation;
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
    if (existing) return 'DUPLICATE';

    let message;
    try {
      message = await prisma.message.create({
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
    } catch (error) {
      // Two identical webhook/widget retries may race past the read above. The
      // database uniqueness constraint is the final idempotency boundary.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'DUPLICATE';
      throw error;
    }

    // Copy the attachment out of the provider before its link expires. Awaited
    // rather than fired and forgotten, so the attachment is on the message by
    // the time the socket event tells an agent there is something to look at.
    if (inbound.media) {
      await ingestInboundMedia({
        messageId: message.id,
        organizationId: account.organizationId,
        channelType: account.channelType,
        accountId: account.id,
        media: inbound.media,
        caption: inbound.text,
      }).catch((err) => {
        // The text/message identity is already durable. A temporary media CDN
        // or download failure must not hide the WhatsApp message from Inbox.
        logger.warn({ err, messageId: message.id, channelType: account.channelType }, 'Inbound media download failed; message retained');
      });
    }

    /*
     * Let the automation engine see it.
     *
     * Fired after the message is safely stored and never awaited: a workflow
     * that is slow or broken must not delay the socket event putting the
     * message in front of an agent, and must never lose the message itself.
     * `dispatch` already swallows its own failures.
     */
    {
      const wfPayload = {
        channel: account.channelType,
        text: inbound.text ?? '',
        contentType: inbound.contentType,
        customerId: identity.customerId,
        conversationId: conversation.id,
        customerName: `${identity.customer.firstName} ${identity.customer.lastName ?? ''}`.trim(),
        isFirstMessage: isNewConversation,
      };
      const wfTarget = {
        entityType: 'CONVERSATION' as const,
        entityId: conversation.id,
        customerId: identity.customerId,
        ownerId: conversation.assignedToId,
      };
      // A brand-new thread is both events: the conversation started, and a
      // message arrived. Rules on either should fire.
      if (isNewConversation) {
        void workflowService.dispatch('conversation.started', wfPayload, wfTarget);
      }
      void workflowService.dispatch('message.received', wfPayload, wfTarget);
    }

    // Persist names such as “I am Victor” before AI handoff/auto-reply runs.
    const placeholderName = /^(website|visitor|guest|anonymous|unknown|customer)$/i.test(
      identity.customer.firstName.trim(),
    );
    const sharedName = account.channelType === 'WEB_CHAT' && (identity.customer.isProvisional || placeholderName)
      ? statedName(inbound.text)
      : null;
    if (sharedName) {
      const [firstName, ...lastName] = sharedName.split(/\s+/);
      await prisma.customer.update({
        where: { id: identity.customerId },
        data: {
          firstName: firstName!,
          lastName: lastName.join(' ') || null,
          displayName: sharedName,
          isProvisional: false,
        },
      });
      identity.customer.firstName = firstName!;
      identity.customer.lastName = lastName.join(' ') || null;
      identity.customer.displayName = sharedName;
      identity.customer.isProvisional = false;
    }

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
      ).catch((err) => logger.warn({ err, conversationId: conversation.id }, 'Inbound notification failed'));
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
    return 'PERSISTED';
  },

  /**
   * Bot guardrails: account toggle on, AI configured, conversation open and
   * unassigned, prior sentiment not negative, and the triggering message is
   * still the latest (avoids replying over a racing agent/bot message).
   */
  async tryAutoReply(accountId: string, conversationId: string, inboundMessageId: string) {
    const account = await prisma.channelAccount.findFirst({ where: { id: accountId } });
    // Read from the channel's own setting: auto-reply is per instance, so the
    // support inbox answering by itself must not make the invoices one do the
    // same.
    if (!account || !account.autoReply || !account.isActive || account.status !== 'CONNECTED' || account.deletedAt) return;

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

    // AI generation is asynchronous and can take several seconds. The owner
    // may switch auto-reply off while it is running, so enforce the setting a
    // second time at the actual send boundary. This applies identically to
    // email and every webhook-backed channel.
    const stillEnabled = await prisma.channelAccount.findFirst({
      where: { id: accountId, autoReply: true, isActive: true, status: 'CONNECTED', deletedAt: null },
      select: { id: true },
    });
    if (!stillEnabled) return;

    const stillLatest = await prisma.message.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (stillLatest?.id !== inboundMessageId) return;

    await this.sendMessage(
      conversationId,
      typeof reply === 'string' ? reply : reply.text,
      null,
      'BOT',
      typeof reply === 'string' ? undefined : reply.mediaUrls,
    );
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
    authorType: 'AGENT' | 'BOT' = 'AGENT',
    mediaUrls?: string[],
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

    const safeMediaUrls = (mediaUrls ?? []).filter((url) => /^https?:\/\//i.test(url)).slice(0, 3);
    const needsLinkFallback = ['WEB_CHAT', 'EMAIL'].includes(conversation.channelAccount.channelType);
    const deliveredText = safeMediaUrls.length && needsLinkFallback
      ? `${text}\n\nSample images:\n${safeMediaUrls.join('\n')}`
      : text;
    const message = await prisma.message.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId,
        direction: 'OUTBOUND',
        authorType,
        authorUserId,
        aiGenerated: authorType === 'BOT',
        contentType: 'TEXT',
        body: deliveredText,
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
          text: deliveredText,
          mediaUrls: safeMediaUrls,
          ...(conversation.channelAccount.channelType === 'EMAIL' && replySubject ? { subject: replySubject } : {}),
        },
        toAccountRef(conversation.channelAccount)
      );
      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date() },
      });
      await markOutboundMessageSent(conversation.channelAccount.id);
      // A send that worked is the same proof a webhook is: the credentials are
      // good. WhatsApp remains SETUP_REQUIRED until an inbound signed webhook
      // proves that Meta can reach us; outbound success alone is not inbound proof.
      if (conversation.channelAccount.channelType !== 'WHATSAPP' && conversation.channelAccount.status !== 'CONNECTED') {
        await markChannelConnected(conversation.channelAccount.id);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'FAILED', errorMessage: raw },
      });
      // Decide what the failure says about the channel itself — an expired
      // token needs the business to reconnect, a rate limit does not.
      await markChannelError(
        conversation.channelAccount.id,
        conversation.channelAccount.channelType,
        raw,
      );
      throw e;
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), lastMessageText: deliveredText.slice(0, 200) },
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
            displayName: true,
            email: true,
            phone: true,
            lifetimeValue: true,
            totalOrders: true,
            aiSummary: true,
            identities: { select: { channelType: true, externalId: true, displayName: true, profileUrl: true } },
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
        select: { channelType: true, displayName: true, externalId: true, profileUrl: true, channelAccountId: true },
      }),
      prisma.conversation.findMany({
        where: { customerId },
        orderBy: { lastMessageAt: 'desc' },
        select: {
          id: true, status: true, unreadCount: true, lastMessageText: true, lastMessageAt: true,
          channelAccount: { select: { channelType: true, name: true } },
        },
      }),
      prisma.channelAccount.findMany({
        where: { isActive: true, status: 'CONNECTED', deletedAt: null },
        select: { channelType: true },
      }),
    ]);
    const connected = [...new Set(accounts.map((a) => a.channelType))];
    return {
      channels: identities.map((i) => ({
        channelType: i.channelType,
        handle: i.displayName ?? i.externalId,
        externalId: i.externalId,
        profileUrl: i.profileUrl,
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
      ? await prisma.channelAccount.findFirst({ where: { id: identity.channelAccountId, isActive: true, status: 'CONNECTED', deletedAt: null } })
      : await prisma.channelAccount.findFirst({ where: { channelType, isActive: true, status: 'CONNECTED', deletedAt: null } });
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

  /**
   * Ask the customer in this conversation to pay (§10).
   *
   * Raises an intent through the same service every other surface uses — the
   * agent cannot set a price for an order or invoice, because the figure is
   * read from the record — then sends the pay link into the thread and records
   * it on the CRM timeline so the conversation and the customer's history agree.
   */
  async createPaymentRequest(
    conversationId: string,
    input: {
      resourceType: 'ORDER' | 'INVOICE' | 'DEPOSIT' | 'CUSTOM';
      resourceId?: string;
      amount?: number;
      description?: string;
    },
    membershipId: string | null
  ) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      select: { id: true, organizationId: true, customerId: true },
    });
    if (!conversation) throw new NotFoundError('Conversation');

    const { createIntentForResource } = await import('../payments/payment-request.service');
    const { publicPayUrl } = await import('../payments/payment-intent.service');

    const intent = await createIntentForResource({
      organizationId: conversation.organizationId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      customerId: conversation.customerId,
      amount: input.amount,
      description: input.description,
      channel: 'INBOX',
      createdById: membershipId,
    });

    const payUrl = publicPayUrl(intent.token!);
    const amount = `${intent.currency} ${Number(intent.amount).toLocaleString()}`;
    const text =
      `Payment request${intent.description ? ` — ${intent.description}` : ''}\n` +
      `${amount}\n${payUrl}\nReference ${intent.reference}`;

    // Best-effort: the request exists whether or not the channel accepts the
    // message, and an agent can always copy the link out of the response.
    let delivered = true;
    try {
      await this.sendMessage(conversationId, text, null, 'AGENT');
    } catch (err) {
      delivered = false;
      logger.warn(
        { err: (err as Error).message, conversationId },
        'payment request raised but the message could not be delivered'
      );
    }

    return {
      reference: intent.reference,
      amount: Number(intent.amount),
      currency: intent.currency,
      description: intent.description,
      status: intent.status,
      expiresAt: intent.expiresAt,
      payUrl,
      delivered,
    };
  },
};
