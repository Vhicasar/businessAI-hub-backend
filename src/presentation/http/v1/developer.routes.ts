import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { apiKeysService, API_SCOPES } from '../../../application/api-keys/api-keys.service';
import { webhooksService, WEBHOOK_EVENTS } from '../../../application/api-keys/webhooks.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Developer portal management API (session-authenticated). */
export const developerRoutes = Router();
developerRoutes.use(authenticate, requireTenant);

/** The scopes and webhook events available, for building the portal UI. */
developerRoutes.get(
  '/scopes',
  wrap(async (_req, res) => {
    res.json({ success: true, data: { apiScopes: API_SCOPES, webhookEvents: WEBHOOK_EVENTS } });
  })
);

// ── API keys ─────────────────────────────────────────────────────────────
developerRoutes.get(
  '/api-keys',
  requirePermission('api_keys.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await apiKeysService.list() });
  })
);

developerRoutes.post(
  '/api-keys',
  requirePermission('api_keys.create'),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(API_SCOPES)).min(1),
      expiresAt: z.string().datetime().nullable().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await apiKeysService.create(req.body, req.auth!.userId) });
  })
);

developerRoutes.delete(
  '/api-keys/:id',
  requirePermission('api_keys.revoke'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await apiKeysService.revoke(req.params.id as string) });
  })
);

// ── Webhooks ─────────────────────────────────────────────────────────────
developerRoutes.get(
  '/webhooks',
  requirePermission('webhooks.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await webhooksService.list() });
  })
);

developerRoutes.post(
  '/webhooks',
  requirePermission('webhooks.create'),
  validate({ body: z.object({ url: z.string().url(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }) }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await webhooksService.create(req.body) });
  })
);

developerRoutes.patch(
  '/webhooks/:id',
  requirePermission('webhooks.update'),
  validate({
    body: z.object({
      url: z.string().url().optional(),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await webhooksService.update(req.params.id as string, req.body) });
  })
);

developerRoutes.delete(
  '/webhooks/:id',
  requirePermission('webhooks.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await webhooksService.remove(req.params.id as string) });
  })
);
