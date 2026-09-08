import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { ChannelType } from '@prisma/client';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { prisma } from '../../../infrastructure/database/prisma';
import { inboxService } from '../../../application/inbox/inbox.service';
import { markWebhookReceived } from '../../../application/inbox/channel-health.service';
import { MockMessagingAdapter } from '../../../infrastructure/channels/mock.adapter';
import { NotFoundError, ValidationError } from '../../../shared/errors';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Simulate a provider, for development and demos.
 *
 * Lets the team drive the whole inbox — incoming messages, media, delivery and
 * read receipts — before Meta has approved anything. The simulated message
 * goes through `inboxService.processInbound`, the same function a real webhook
 * calls, so conversation creation, customer matching, deduplication, media
 * ingestion, socket events and auto-reply all behave exactly as they will in
 * production. A shortcut that wrote rows directly would prove none of that.
 *
 * Two things keep this out of harm's way: the router is only mounted when
 * NODE_ENV is not production (see app.ts), and every route still demands a
 * signed-in member with permission to manage channels. It simulates the
 * provider, never the tenant.
 */
export const mockMessagingRoutes = Router();
mockMessagingRoutes.use(authenticate, requireTenant);

const SIMULATABLE = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK_MESSENGER', 'TELEGRAM', 'SMS'] as const;

/** The account to simulate against, verified to belong to the caller's org. */
async function accountFor(organizationId: string, accountId?: string, channelType?: string) {
  const account = accountId
    ? await prisma.channelAccount.findFirst({ where: { id: accountId, deletedAt: null } })
    : await prisma.channelAccount.findFirst({
        where: { channelType: channelType as ChannelType, deletedAt: null, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
  if (!account) {
    throw new NotFoundError(
      accountId ? 'Channel account' : `No connected ${channelType} channel to simulate against`,
    );
  }
  // The tenant-scoped client already confines the query; this is the belt to
  // that braces, because a simulation endpoint writing into another business's
  // inbox would be the worst possible bug to ship here.
  if (account.organizationId !== organizationId) throw new NotFoundError('Channel account');
  return account;
}

const inboundSchema = z.object({
  channelType: z.enum(SIMULATABLE).optional(),
  accountId: z.string().optional(),
  /** Who it is from — a phone number, an Instagram handle, anything stable. */
  from: z.string().trim().min(1).max(120).default('2348030000001'),
  senderName: z.string().trim().max(120).optional(),
  text: z.string().trim().max(4000).optional(),
  contentType: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LOCATION']).default('TEXT'),
  /** Attach a simulated file, so media ingestion runs end to end. */
  withMedia: z.boolean().default(false),
  /** Supply one to replay it and prove deduplication. */
  providerMessageId: z.string().trim().max(200).optional(),
}).refine((d) => d.channelType || d.accountId, {
  message: 'Give either a channelType or an accountId',
});

/** Simulate a customer sending a message in. */
mockMessagingRoutes.post(
  '/inbound',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: inboundSchema }),
  wrap(async (req, res) => {
    const organizationId = req.auth!.organizationId!;
    const account = await accountFor(organizationId, req.body.accountId, req.body.channelType);

    if (req.body.contentType !== 'TEXT' && !req.body.text && !req.body.withMedia) {
      throw new ValidationError('A non-text message needs either text or withMedia');
    }

    const providerMessageId = req.body.providerMessageId ?? `mock.${randomUUID()}`;
    await markWebhookReceived(account.id);
    await inboxService.processInbound(
      { id: account.id, organizationId, channelType: account.channelType },
      {
        providerMessageId,
        senderExternalId: req.body.from,
        senderDisplayName: req.body.senderName,
        contentType: req.body.contentType,
        text: req.body.text,
        sentAt: new Date(),
        ...(req.body.withMedia
          ? { media: { externalId: `mock-media-${randomUUID()}`, mimeType: 'image/png' } }
          : {}),
      },
    );

    const message = await prisma.message.findFirst({
      where: { providerMessageId },
      select: { id: true, conversationId: true, contentType: true, body: true },
    });
    res.status(201).json({
      success: true,
      message: 'Simulated inbound message delivered to the inbox.',
      data: { providerMessageId, message },
    });
  }),
);

const statusSchema = z.object({
  /** The provider id returned when the message was sent. */
  providerMessageId: z.string().trim().min(1).max(200),
  status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']),
  error: z.string().trim().max(300).optional(),
});

/** Simulate a delivery or read receipt for something we sent. */
mockMessagingRoutes.post(
  '/status',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: statusSchema }),
  wrap(async (req, res) => {
    const organizationId = req.auth!.organizationId!;
    const message = await prisma.message.findFirst({
      where: { providerMessageId: req.body.providerMessageId, direction: 'OUTBOUND' },
      select: { id: true, conversation: { select: { channelAccountId: true } } },
    });
    if (!message) throw new NotFoundError('Outbound message with that provider id');

    await inboxService.applyStatus(
      { id: message.conversation.channelAccountId, organizationId },
      {
        providerMessageId: req.body.providerMessageId,
        status: req.body.status,
        occurredAt: new Date(),
        error: req.body.error,
      },
    );
    const updated = await prisma.message.findFirst({
      where: { id: message.id },
      select: { id: true, status: true, deliveredAt: true, readAt: true },
    });
    res.json({ success: true, message: `Simulated ${req.body.status} receipt.`, data: updated });
  }),
);

/** What can be simulated, so a demo does not have to guess. */
mockMessagingRoutes.get(
  '/',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  wrap(async (_req, res) => {
    const accounts = await prisma.channelAccount.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true, channelType: true, status: true },
    });
    res.json({
      success: true,
      data: {
        simulatable: SIMULATABLE,
        accounts,
        adapter: new MockMessagingAdapter('WHATSAPP').channelType,
        note: 'Development only. Messages travel the same path as real provider webhooks.',
      },
    });
  }),
);
