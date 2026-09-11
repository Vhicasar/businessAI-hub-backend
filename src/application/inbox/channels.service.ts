import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { encrypt } from '../../shared/crypto';
import { env } from '../../shared/config/env';
import {
  newWebhookSecret,
  oauthUnavailableReason,
  supportsOAuth,
  type ResolvedConnection,
} from './channel-oauth.service';
import { capabilitiesFor } from './channel-capabilities';
import { channelPolicy } from '../settings/workspace-config';
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
    INSTAGRAM: ['accessToken', 'instagramAccountId'],
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
      return dto.credentials.pageId || randomUUID();
    case 'INSTAGRAM':
      return dto.credentials.instagramAccountId || randomUUID();
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

function metaRoutingFields(channelType: string, credentials: Record<string, string>) {
  return {
    metaWabaId: channelType === 'WHATSAPP' ? credentials.wabaId || null : null,
    metaPhoneNumberId: channelType === 'WHATSAPP' ? credentials.phoneNumberId || null : null,
    metaFacebookPageId: channelType === 'FACEBOOK_MESSENGER' ? credentials.pageId || null : null,
    metaInstagramAccountId: channelType === 'INSTAGRAM' ? credentials.instagramAccountId || null : null,
  };
}

/** Provider details safe to return to the settings UI. Never copy secrets. */
function safeManualMetadata(channelType: string, credentials: Record<string, string>): Record<string, unknown> {
  const common = { connectedVia: 'manual_credentials', connectedAt: new Date().toISOString() };
  switch (channelType) {
    case 'WHATSAPP': return { ...common, phoneNumberId: credentials.phoneNumberId ?? null };
    case 'FACEBOOK_MESSENGER': return { ...common, facebookPageId: credentials.pageId ?? null };
    case 'INSTAGRAM': return { ...common, instagramAccountId: credentials.instagramAccountId ?? null };
    case 'TELEGRAM': return { ...common, botId: credentials.botToken?.split(':')[0] ?? null };
    case 'EMAIL': return { ...common, emailAddress: credentials.imapUser ?? null, imapHost: credentials.imapHost ?? null };
    case 'SMS': return { ...common, fromNumber: credentials.fromNumber ?? null, messagingServiceSid: credentials.messagingServiceSid ?? null };
    case 'TIKTOK': return { ...common, openId: credentials.openId ?? null };
    case 'WEB_CHAT': return { ...common };
    default: return common;
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
  // Health, so the page can say *why* a channel is not working rather than
  // only that it is off. Deliberately alongside isActive rather than
  // replacing it: existing callers keep working.
  status: true,
  lastWebhookAt: true,
  lastError: true,
  lastErrorAt: true,
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
    const accounts = await prisma.channelAccount.findMany({
      where: { deletedAt: null },
      select: accountSelect,
      // Grouped by type so the screen can show "Email channels: Support,
      // Invoices" rather than one flat list.
      orderBy: [{ channelType: 'asc' }, { createdAt: 'asc' }],
    });

    /*
     * A channel the platform has switched off is not shown at all.
     *
     * It used to be listed with "not available on this platform" underneath,
     * which is an odd thing to show a business — an option it can see, cannot
     * use, and did not ask about.
     *
     * The exception is a channel a business already has connected. Hiding one
     * of those would take a live, message-receiving connection off the screen
     * and leave no way to disconnect it, so it stays visible; what disappears
     * is the ability to add another.
     */
    const connectedTypes = new Set(accounts.map((a) => a.channelType));
    const supported = supportedChannels().filter(
      (channelType) => channelPolicy(channelType).available || connectedTypes.has(channelType),
    );
    const allowances = await allowanceSummary(organizationId, supported);

    /*
     * What each channel can do, and how it can be connected.
     *
     * Sent with the list so the settings page and the composer can be honest
     * without hard-coding provider rules of their own: no template picker on
     * Instagram, no "Connect with Facebook" button on a deployment where the
     * Meta app has not been configured.
     */
    const channels = supported.map((channelType) => ({
      channelType,
      capabilities: capabilitiesFor(channelType),
      oauth: {
        supported: supportsOAuth(channelType),
        // Present only when it cannot be used, and phrased for the person who
        // has to do something about it.
        unavailableReason: supportsOAuth(channelType)
          ? null
          : oauthUnavailableReason(channelType),
      },
    }));

    return { accounts, supported, allowances, purposes: CHANNEL_PURPOSES, channels };
  },

  async connect(organizationId: string, dto: ConnectChannelDto) {
    const adapter = getAdapter(dto.channelType);
    const webhookSecret = randomUUID().replace(/-/g, '');
    const externalId = deriveExternalId(dto);

    // Include soft-deleted rows. The database unique key still reserves their
    // organization/channel/external-id tuple, so creating a replacement would
    // fail with P2002. A disconnected channel is restored in place instead,
    // preserving its inbox history and webhook identity.
    const existing = await prisma.channelAccount.findFirst({
      where: { channelType: dto.channelType, externalId },
    });
    if (existing && !existing.deletedAt) throw new ConflictError('This account is already connected');

    // Enforced here, not only in the UI: how many instances a business may run
    // is a billing decision, and the endpoint is reachable without the screen.
    if (!existing) {
      const allowance = await allowanceFor(organizationId, dto.channelType);
      if (!allowance.canAddMore) throw new ConflictError(allowance.blockedReason ?? 'Channel limit reached');
    }

    const account = existing
      ? await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            name: dto.name,
            purpose: dto.purpose,
            autoReply: dto.autoReply,
            credentialsEnc: encrypt(JSON.stringify(dto.credentials)),
            metadata: safeManualMetadata(dto.channelType, dto.credentials) as never,
            webhookSecret: existing.webhookSecret || webhookSecret,
            isActive: true,
            status: 'CONNECTED',
            lastError: null,
            lastErrorAt: null,
            deletedAt: null,
            ...metaRoutingFields(dto.channelType, dto.credentials),
          },
        })
      : await prisma.channelAccount.create({
          data: {
            organizationId,
            channelType: dto.channelType,
            name: dto.name,
            purpose: dto.purpose,
            autoReply: dto.autoReply,
            externalId,
            credentialsEnc: encrypt(JSON.stringify(dto.credentials)),
            metadata: safeManualMetadata(dto.channelType, dto.credentials) as never,
            webhookSecret,
            ...metaRoutingFields(dto.channelType, dto.credentials),
          },
        });

    await recordChannelEvent(account.id, existing ? 'Channel reconnected' : 'Channel connected', {
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

    const stableMetaPath: Partial<Record<ConnectChannelDto['channelType'], string>> = {
      WHATSAPP: 'whatsapp', FACEBOOK_MESSENGER: 'messenger', INSTAGRAM: 'instagram',
    };
    const webhookUrl = stableMetaPath[dto.channelType]
      ? `${env.API_BASE_URL}/api/webhooks/${stableMetaPath[dto.channelType]}`
      : `${env.API_BASE_URL}/api/webhooks/${dto.channelType.toLowerCase()}/${account.id}`;
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
          webhookSecret: account.webhookSecret,
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

  /**
   * Store a connection that came back from the provider's own OAuth dialog.
   *
   * Deliberately separate from `connect`: that one takes credentials a person
   * typed and validates the shape of them, while this one takes what the
   * provider itself said the business owns. Everything after the credentials —
   * the duplicate check, the plan allowance, encryption, the audit entry — is
   * the same, because connecting a channel means the same thing either way.
   *
   * Reconnecting an account the business already has updates it in place
   * rather than being refused as a duplicate: an expired token is the most
   * common reason anyone runs this flow a second time.
   */
  async connectFromOAuth(connection: ResolvedConnection) {
    const { organizationId, channelType, externalId } = connection;

    const existing = await prisma.channelAccount.findFirst({
      // Disconnection is a soft delete. Include that row here: the database
      // unique key still reserves (organization, channel, externalId), so
      // attempting to create a new row would fail with P2002. Reconnecting
      // restores the original row and keeps its conversation history.
      where: { channelType, externalId },
      select: { id: true, organizationId: true, name: true },
    });
    if (existing && existing.organizationId !== organizationId) {
      throw new ConflictError(
        'That account is already connected to another business on Vhicasar.',
      );
    }

    if (!existing) {
      const allowance = await allowanceFor(organizationId, channelType);
      if (!allowance.canAddMore) {
        throw new ConflictError(allowance.blockedReason ?? 'Channel limit reached');
      }
    }

    const webhookSecret = existing ? undefined : newWebhookSecret();
    const account = existing
      ? await prisma.channelAccount.update({
          where: { id: existing.id },
          data: {
            credentialsEnc: encrypt(JSON.stringify(connection.credentials)),
            metadata: connection.metadata as never,
            // A reconnect is also how a disabled account comes back — and how
            // an expired one is repaired, which is the whole point of showing
            // EXPIRED in the first place.
            isActive: true,
            status: 'CONNECTED',
            deletedAt: null,
            lastError: null,
            lastErrorAt: null,
            ...metaRoutingFields(channelType, connection.credentials),
          },
        })
      : await prisma.channelAccount.create({
          data: {
            organizationId,
            channelType,
            name: connection.displayName,
            purpose: 'GENERAL',
            // Off by default: what answers a customer unattended is a decision
            // the business makes deliberately, not a side effect of connecting.
            autoReply: false,
            externalId,
            credentialsEnc: encrypt(JSON.stringify(connection.credentials)),
            metadata: connection.metadata as never,
            webhookSecret,
            ...metaRoutingFields(channelType, connection.credentials),
          },
        });

    await recordChannelEvent(account.id, existing ? 'Channel reconnected' : 'Channel connected', {
      body: [
        `Type: ${channelType}`,
        `Account: ${connection.displayName}`,
        'Connected through the provider sign-in, not typed-in credentials.',
      ].join('\n'),
      metadata: {
        channelType,
        externalId,
        connectedVia: connection.metadata.connectedVia ?? 'oauth',
      },
    });

    return {
      id: account.id,
      channelType: account.channelType,
      name: account.name,
      externalId: account.externalId,
      isActive: account.isActive,
      reconnected: Boolean(existing),
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
      data: {
        isActive: false,
        // Somebody chose this, so it is not an error and must not read as one.
        status: 'DISCONNECTED',
        lastError: null,
        lastErrorAt: null,
        deletedAt: new Date(),
      },
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
