import { Router, type Request, type RequestHandler, type Response } from 'express';
import { ConflictError } from '../../../shared/errors';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  inboxService,
  listConversationsSchema,
  sendMessageSchema,
} from '../../../application/inbox/inbox.service';
import {
  channelsService,
  updateChannelSchema,
  connectChannelSchema,
} from '../../../application/inbox/channels.service';
import { authorizationUrl, completeCallback, subscribeWebhooks, whatsappEmbeddedSignupConfig } from '../../../application/inbox/channel-oauth.service';
import { isAutomaticChannelConnectEnabled } from '../../../application/settings/workspace-config';
import { allowanceFor } from '../../../application/inbox/channel-allowance.service';
import type { ChannelType } from '@prisma/client';
import { env } from '../../../shared/config/env';
import { logger } from '../../../shared/logger';
import { markChannelAwaitingWebhook, markChannelSetupFailed, markWebhookSubscription } from '../../../application/inbox/channel-health.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const inboxRoutes = Router();
inboxRoutes.use(authenticate, requireTenant);

// unread badge counts (total + per channel)
inboxRoutes.get(
  '/unread',
  requirePermission('inbox.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await inboxService.unreadCounts() });
  })
);

// conversations
inboxRoutes.get(
  '/conversations',
  requirePermission('inbox.read'),
  validate({ query: listConversationsSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await inboxService.listConversations(req.query as never, req.auth!.membershipId),
    });
  })
);

inboxRoutes.get(
  '/conversations/:id',
  requirePermission('inbox.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inboxService.getThread(req.params.id as string) });
  })
);

inboxRoutes.post(
  '/conversations/:id/messages',
  requirePermission('inbox.reply'),
  validate({ body: sendMessageSchema }),
  wrap(async (req, res) => {
    const data = await inboxService.sendMessage(
      req.params.id as string,
      req.body.text,
      req.auth!.userId,
      'AGENT'
    );
    res.status(201).json({ success: true, data });
  })
);

inboxRoutes.post(
  '/conversations/:id/read',
  requirePermission('inbox.read'),
  wrap(async (req, res) => {
    await inboxService.markRead(req.params.id as string);
    res.json({ success: true, data: { message: 'Marked read' } });
  })
);

inboxRoutes.post(
  '/conversations/:id/assign',
  requirePermission('inbox.assign'),
  validate({ body: z.object({ membershipId: z.string().nullable() }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await inboxService.assign(req.params.id as string, req.body.membershipId),
    });
  })
);

inboxRoutes.post(
  '/conversations/:id/status',
  requirePermission('inbox.resolve'),
  validate({
    body: z.object({ status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED', 'SPAM']) }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await inboxService.setStatus(req.params.id as string, req.body.status),
    });
  })
);

/**
 * Raise a payment request from inside a conversation (§10).
 *
 * The agent names what is being paid for, not how much: the amount comes from
 * the order or invoice, and a free-text charge needs an explicit amount and the
 * permission to ask for one. The customer receives a card with a pay link whose
 * methods are resolved when they open it, so it reflects the business's
 * settings at that moment rather than at the moment the agent typed.
 */
inboxRoutes.post(
  '/conversations/:id/payment-request',
  requirePermission('payments.request'),
  validate({
    body: z.object({
      resourceType: z.enum(['ORDER', 'INVOICE', 'DEPOSIT', 'CUSTOM']),
      resourceId: z.string().trim().max(60).optional(),
      amount: z.number().positive().max(1_000_000_000).optional(),
      description: z.string().trim().max(300).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await inboxService.createPaymentRequest(
      req.params.id as string,
      req.body,
      req.auth?.membershipId ?? null
    );
    res.status(201).json({ success: true, data });
  })
);

// channel accounts
inboxRoutes.get(
  '/channels',
  requirePermission('inbox.read', 'settings.manage_integrations'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await channelsService.list(req.auth!.organizationId!) });
  })
);

inboxRoutes.post(
  '/channels',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: connectChannelSchema }),
  wrap(async (req, res) => {
    const data = await channelsService.connect(req.auth!.organizationId!, req.body);
    res.status(201).json({ success: true, data });
  })
);

inboxRoutes.post(
  '/channels/:id/diagnostic',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await channelsService.diagnose(req.params.id as string) });
  })
);

/**
 * Start a one-click connection.
 *
 * Returns the provider's authorisation URL rather than redirecting, so the
 * browser can open it in a popup and the settings page stays where it is.
 */
inboxRoutes.post(
  '/channels/:channel/connect/start',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  wrap(async (req, res) => {
    const channelType = String(req.params.channel).toUpperCase() as ChannelType;
    if (!isAutomaticChannelConnectEnabled(channelType)) {
      throw new ConflictError('Automatic WhatsApp Business connection is currently disabled by Vhicasar.');
    }
    // Refuse here rather than after a round trip to Meta: the connect flow is
    // already gated at the callback, but failing only there means sending the
    // business off to authorise an account we were never going to accept.
    const allowance = await allowanceFor(req.auth!.organizationId!, channelType);
    if (!allowance.canAddMore) {
      throw new ConflictError(allowance.blockedReason ?? 'This channel cannot be connected.');
    }
    if (channelType === 'WHATSAPP' && env.meta.whatsappConfigId) {
      const data = whatsappEmbeddedSignupConfig({
        organizationId: req.auth!.organizationId!, userId: req.auth!.userId,
        returnTo: `${env.WEB_APP_URL}/settings/integrations?tab=channels`,
      });
      logger.info({ event: 'WHATSAPP_SIGNUP_STARTED', connectionAttemptId: data.connectionAttemptId, tenantId: req.auth!.organizationId }, 'WhatsApp Embedded Signup started');
      res.json({ success: true, data: { embeddedSignup: data } });
      return;
    }
    const { url } = authorizationUrl({
      channelType,
      organizationId: req.auth!.organizationId!,
      userId: req.auth!.userId,
      returnTo: `${env.WEB_APP_URL}/settings/integrations?tab=channels`,
    });
    res.json({ success: true, data: { url } });
  })
);

const embeddedSignupCompleteSchema = z.object({
  code: z.string().min(1), state: z.string().min(1), connectionAttemptId: z.string().uuid(),
  wabaId: z.string().regex(/^\d+$/).optional(), phoneNumberId: z.string().regex(/^\d+$/).optional(),
  connectionMode: z.enum(['STANDARD_CLOUD_API', 'WHATSAPP_BUSINESS_APP_COEXISTENCE']),
});

inboxRoutes.post(
  '/channels/whatsapp/embedded-signup/complete',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: embeddedSignupCompleteSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof embeddedSignupCompleteSchema>;
    logger.info({ event: 'WHATSAPP_OAUTH_CODE_RECEIVED', connectionAttemptId: body.connectionAttemptId, tenantId: req.auth!.organizationId }, 'WhatsApp OAuth code received');
    if (body.wabaId) logger.info({ event: 'WHATSAPP_SESSION_INFO_RECEIVED', connectionAttemptId: body.connectionAttemptId, tenantId: req.auth!.organizationId, hasWabaId: true, hasPhoneNumberId: Boolean(body.phoneNumberId) }, 'WhatsApp signup session received');
    if (body.connectionMode === 'WHATSAPP_BUSINESS_APP_COEXISTENCE') logger.info({ event: 'WHATSAPP_COEXISTENCE_FINISHED', connectionAttemptId: body.connectionAttemptId, tenantId: req.auth!.organizationId }, 'WhatsApp Business App onboarding finished');

    const connection = await completeCallback({
      channelType: 'WHATSAPP', code: body.code, state: body.state,
      whatsappSession: { wabaId: body.wabaId, phoneNumberId: body.phoneNumberId, connectionMode: body.connectionMode, connectionAttemptId: body.connectionAttemptId },
    });
    if (connection.organizationId !== req.auth!.organizationId || connection.userId !== req.auth!.userId) {
      throw new ConflictError('This WhatsApp connection was started by a different workspace or user.');
    }
    logger.info({ event: 'WHATSAPP_WABA_RESOLVED', connectionAttemptId: body.connectionAttemptId, tenantId: connection.organizationId, wabaId: connection.credentials.wabaId }, 'WhatsApp Business Account resolved');
    logger.info({ event: 'WHATSAPP_PHONE_NUMBER_RESOLVED', connectionAttemptId: body.connectionAttemptId, tenantId: connection.organizationId, phoneNumberId: connection.credentials.phoneNumberId }, 'WhatsApp phone number resolved');
    const account = await channelsService.connectFromOAuth(connection);
    try {
      logger.info({ event: 'WHATSAPP_WABA_SUBSCRIBE_STARTED', connectionAttemptId: body.connectionAttemptId, tenantId: connection.organizationId }, 'WhatsApp WABA subscription started');
      await subscribeWebhooks(connection);
      await markWebhookSubscription(account.id, 'READY');
      await markChannelAwaitingWebhook(account.id, 'WHATSAPP');
      logger.info({ event: 'WHATSAPP_WABA_SUBSCRIBED', connectionAttemptId: body.connectionAttemptId, tenantId: connection.organizationId, channelAccountId: account.id }, 'WhatsApp WABA subscription verified');
      logger.info({ event: 'WHATSAPP_CONNECTION_READY', connectionAttemptId: body.connectionAttemptId, tenantId: connection.organizationId, channelAccountId: account.id }, 'WhatsApp connection awaiting first signed webhook');
    } catch (error) {
      await markWebhookSubscription(account.id, 'FAILED');
      await markChannelSetupFailed(account.id, 'WHATSAPP', `Webhook subscription failed: ${(error as Error).message}`);
      throw error;
    }
    res.json({ success: true, data: { accountId: account.id, accountName: account.name, status: 'SETUP_REQUIRED' } });
  }),
);

inboxRoutes.patch(
  '/channels/:id/auto-reply',
  // Deciding what answers a customer unattended is its own trust level.
  requirePermission('inbox.configure_auto_reply', 'inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: z.object({ enabled: z.boolean() }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await channelsService.setAutoReply(req.params.id as string, req.body.enabled),
    });
  })
);

/** Rename an instance, or change what it is used for. */
inboxRoutes.patch(
  '/channels/:id',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: updateChannelSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await channelsService.update(req.params.id as string, req.body),
    });
  })
);

inboxRoutes.delete(
  '/channels/:id',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  wrap(async (req, res) => {
    await channelsService.disconnect(req.params.id as string);
    res.json({ success: true, data: { message: 'Channel disconnected' } });
  })
);
