import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { enforceLimit } from '../middleware/plan-guard';
import {
  inboxService,
  listConversationsSchema,
  sendMessageSchema,
} from '../../../application/inbox/inbox.service';
import {
  channelsService,
  connectChannelSchema,
} from '../../../application/inbox/channels.service';

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

// channel accounts
inboxRoutes.get(
  '/channels',
  requirePermission('inbox.read', 'settings.manage_integrations'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await channelsService.list() });
  })
);

inboxRoutes.post(
  '/channels',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  enforceLimit('channels'),
  validate({ body: connectChannelSchema }),
  wrap(async (req, res) => {
    const data = await channelsService.connect(req.auth!.organizationId!, req.body);
    res.status(201).json({ success: true, data });
  })
);

inboxRoutes.patch(
  '/channels/:id/auto-reply',
  requirePermission('inbox.manage_channels', 'settings.manage_integrations'),
  validate({ body: z.object({ enabled: z.boolean() }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await channelsService.setAutoReply(req.params.id as string, req.body.enabled),
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
