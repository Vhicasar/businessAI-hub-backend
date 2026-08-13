import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { encrypt } from '../../shared/crypto';
import { env } from '../../shared/config/env';
import { getAdapter, supportedChannels } from '../../infrastructure/channels/registry';
import { activityService } from '../crm/activity.service';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import {
  allowanceFor,
  allowanceSummary,
  CHANNEL_PURPOSES,
  CHANNEL_PURPOSE_IDS,
} from './channel-allowance.service';

export const connectChannelSchema = z.object({
  channelType: z.enum([
    'TELEGRAM', 'WHATSAPP', 'FACEBOOK_MESSENGER', 'INSTAGRAM', 'WEB_CHAT', 'EMAIL', 'SMS', 'TIKTOK',
  ]),
  /** What this instance is called — "Support", "Invoices", "Sales". */
  name: z.string().trim().min(1).max(120),
  /** What it is for, which decides what gets sent through it. */
  purpose: z.enum(CHANNEL_PURPOSE_IDS).default('GENERAL'),
  /** Set per instance: support may answer automatically, invoices may not. */
  autoReply: z.boolean().default(false),
  credentials: z.record(z.string()),
}).superRefine((dto, ctx) => {
  const required: Partial<Record<typeof dto.channelType, string[]>> = {
    SMS: ['accountSid', 'authToken'],
    TIKTOK: ['clientKey', 'clientSecret', 'accessToken', 'openId'],
    WHATSAPP: ['accessToken', 'phoneNumberId', 'appSecret'],
    EMAIL: ['imapHost', 'imapUser', 'imapPass', 'smtpHost'],
  };
  for (const key of required[dto.channelType] ?? []) {
    if (!dto.credentials[key]?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentials', key], message: `${key} is required` });
    }
  }
  if (dto.channelType === 'SMS' && !dto.credentials.fromNumber && !dto.credentials.messagingServiceSid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['credentials', 'fromNumber'],
      message: 'A From number or Messaging Service SID is required',
    });
  }
});

/** Stable provider-side account id per channel type. */
function deriveExternalId(dto: ConnectChannelDto): string {
  switch (dto.channelType) {
    case 'TELEGRAM':
      return (dto.credentials.botToken ?? '').split(':')[0] || randomUUID();
    case 'WHATSAPP':
      return dto.credentials.phoneNumberId || randomUUID();
    case 'FACEBOOK_MESSENGER':
    case 'INSTAGRAM':
      return dto.credentials.pageId || randomUUID();
    case 'EMAIL':
      return (dto.credentials.imapUser ?? '').toLowerCase() || randomUUID();
    case 'SMS':
      return dto.credentials.messagingServiceSid || dto.credentials.fromNumber || randomUUID();
    case 'TIKTOK':
      return dto.credentials.openId || randomUUID();
    case 'WEB_CHAT':
    default:
      return randomUUID();
  }
}

export type ConnectChannelDto = z.infer<typeof connectChannelSchema>;

const accountSelect = {
  id: true,
  channelType: true,
  name: true,
  purpose: true,
  autoReply: true,
  externalId: true,
  isActive: true,
  metadata: true,
  createdAt: true,
} as const;

export const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  purpose: z.enum(CHANNEL_PURPOSE_IDS).optional(),
  autoReply: z.boolean().optional(),
});
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;

/**
 * Channel lifecycle on the timeline.
 *
 * Connecting, renaming, repurposing and disconnecting all change what reaches
 * customers, so each is recorded with what it was and what it became. Never
 * throws: an unrecorded event is a gap in the log, not a reason to fail the
 * change the user asked for.
 */
async function recordChannelEvent(
  accountId: string,
  title: string,
  extra: { body?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await activityService.record({
      type: 'SYSTEM',
      entityType: 'CHANNEL',
      entityId: accountId,
      title,
      body: extra.body,
      metadata: { ...(extra.metadata ?? {}), actorMembershipId: requestContext.get()?.membershipId ?? null },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, accountId }, 'channel event not recorded');
  }
}

export const channelsService = {
  async list(organizationId: string) {
    const supported = supportedChannels();
    const accounts = await prisma.channelAccount.findMany({
      where: { deletedAt: null },
      select: accountSelect,
      // Grouped by type so the screen can show "Email channels: Support,
      // Invoices" rather than one flat list.
      orderBy: [{ channelType: 'asc' }, { createdAt: 'asc' }],
    });
    const allowances = await allowanceSummary(organizationId, supported);
    return { accounts, supported, allowances, purposes: CHANNEL_PURPOSES };
  },

  async connect(organizationId: string, dto: ConnectChannelDto) {
    const adapter = getAdapter(dto.channelType);
    const webhookSecret = randomUUID().replace(/-/g, '');
    const externalId = deriveExternalId(dto);

    const dup = await prisma.channelAccount.findFirst({
      where: { channelType: dto.channelType, externalId, deletedAt: null },
    });
    if (dup) throw new ConflictError('This account is already connected');

    // Enforced here, not only in the UI: how many instances a business may run
    // is a billing decision, and the endpoint is reachable without the screen.
    const allowance = await allowanceFor(organizationId, dto.channelType);
    if (!allowance.canAddMore) throw new ConflictError(allowance.blockedReason ?? 'Channel limit reached');

    const account = await prisma.channelAccount.create({
      data: {
        organizationId,
        channelType: dto.channelType,
        name: dto.name,
        purpose: dto.purpose,
        autoReply: dto.autoReply,
        externalId,
        credentialsEnc: encrypt(JSON.stringify(dto.credentials)),
        webhookSecret,
      },
    });

    await recordChannelEvent(account.id, 'Channel connected', {
      body: [
        `Type: ${dto.channelType}`,
        `Name: ${dto.name}`,
        `Purpose: ${dto.purpose}`,
        `Auto-reply: ${dto.autoReply ? 'on' : 'off'}`,
      ].join('\n'),
      metadata: {
        next: { name: dto.name, purpose: dto.purpose, autoReply: dto.autoReply, isActive: true },
        channelType: dto.channelType,
      },
    });

    const webhookUrl = `${env.API_BASE_URL}/api/webhooks/${dto.channelType.toLowerCase()}/${account.id}`;
    let setupNote: string | null = null;
    if (dto.channelType === 'WEB_CHAT') {
      setupNote =
        `Add this to your website before </body>:\n` +
        `<script src="${env.API_BASE_URL}/widget.js" data-account="${account.id}" ` +
        `data-color="#F97316" data-title="Chat with us"></script>`;
    } else if (adapter.onAccountConnected) {
      setupNote = await adapter.onAccountConnected(
        {
          id: account.id,
          organizationId,
          externalId,
          credentials: dto.credentials,
          webhookSecret,
        },
        webhookUrl
      );
    }

    return {
      account: {
        id: account.id,
        channelType: account.channelType,
        name: account.name,
        purpose: account.purpose,
        autoReply: account.autoReply,
        externalId: account.externalId,
        isActive: account.isActive,
        createdAt: account.createdAt,
      },
      webhookUrl,
      setupNote,
    };
  },

  /** Per instance — enabling it on support must not enable it on invoices. */
  async setAutoReply(accountId: string, enabled: boolean) {
    const account = await prisma.channelAccount.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new NotFoundError('Channel account');
    const updated = await prisma.channelAccount.update({
      where: { id: accountId },
      data: { autoReply: enabled },
      select: accountSelect,
    });
    // What answers a customer unattended is worth a record of who decided it.
    await recordChannelEvent(accountId, `Auto-reply ${enabled ? 'enabled' : 'disabled'} on ${account.name}`, {
      metadata: {
        previous: { autoReply: account.autoReply },
        next: { autoReply: enabled },
        channelType: account.channelType,
      },
    });
    return updated;
  },

  /** Rename an instance or change what it is used for. */
  async update(accountId: string, dto: UpdateChannelDto) {
    const account = await prisma.channelAccount.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new NotFoundError('Channel account');
    const updated = await prisma.channelAccount.update({
      where: { id: accountId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
        ...(dto.autoReply !== undefined ? { autoReply: dto.autoReply } : {}),
      },
      select: accountSelect,
    });
    // Changing a channel's purpose redirects what gets sent through it, so the
    // before and after both matter.
    await recordChannelEvent(accountId, `Channel updated — ${updated.name}`, {
      metadata: {
        previous: { name: account.name, purpose: account.purpose, autoReply: account.autoReply },
        next: { name: updated.name, purpose: updated.purpose, autoReply: updated.autoReply },
        channelType: account.channelType,
      },
    });
    return updated;
  },

  async disconnect(accountId: string) {
    const account = await prisma.channelAccount.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new NotFoundError('Channel account');
    await prisma.channelAccount.update({
      where: { id: accountId },
      data: { isActive: false, deletedAt: new Date() },
    });
    await recordChannelEvent(accountId, `Channel disconnected — ${account.name}`, {
      body: 'Messages will no longer arrive from this channel. Its conversation history is kept.',
      metadata: {
        previous: { isActive: true },
        next: { isActive: false },
        channelType: account.channelType,
      },
    });
  },
};
