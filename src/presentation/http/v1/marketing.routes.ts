import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  campaignService,
  createCampaignSchema,
  updateCampaignSchema,
} from '../../../application/messaging/campaign.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const marketingRoutes = Router();
marketingRoutes.use(authenticate, requireTenant);

marketingRoutes.get(
  '/campaigns',
  requirePermission('marketing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await campaignService.list() });
  })
);

marketingRoutes.post(
  '/campaigns',
  requirePermission('marketing.create'),
  validate({ body: createCampaignSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await campaignService.create(req.body) });
  })
);

marketingRoutes.get(
  '/campaigns/audience',
  requirePermission('marketing.read'),
  validate({ query: z.object({ type: z.enum(['EMAIL', 'SMS', 'WHATSAPP']) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.audience(req.query.type as never) });
  })
);

marketingRoutes.get(
  '/campaigns/:id',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.get(req.params.id as string) });
  })
);

marketingRoutes.patch(
  '/campaigns/:id',
  requirePermission('marketing.update'),
  validate({ body: updateCampaignSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.update(req.params.id as string, req.body) });
  })
);

marketingRoutes.post(
  '/campaigns/:id/send',
  requirePermission('marketing.send'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.send(req.params.id as string) });
  })
);
