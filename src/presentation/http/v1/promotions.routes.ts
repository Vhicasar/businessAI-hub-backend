import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { promotionEngine, PROMOTION_KINDS } from '../../../application/marketing/promotion-engine.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const promotionSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).optional(),
  kind: z.enum(PROMOTION_KINDS).default('DISCOUNT'),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).default('PERCENTAGE'),
  discountValue: z.coerce.number().nonnegative(),
  status: z.enum(['SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED']).optional(),
  branchId: z.string().trim().optional(),
  budget: z.coerce.number().positive().optional(),
  minSpend: z.coerce.number().nonnegative().optional(),
  maxRedemptions: z.coerce.number().int().positive().optional(),
  maxPerCustomer: z.coerce.number().int().positive().default(1),
  audience: z.object({
    tiers: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    segmentIds: z.array(z.string()).optional(),
    newCustomersOnly: z.boolean().optional(),
  }).optional(),
  schedule: z.object({
    days: z.array(z.coerce.number().int().min(1).max(7)).optional(),
    from: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    to: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).optional(),
  appliesTo: z.object({
    scope: z.enum(['ALL', 'CATEGORIES', 'PRODUCTS', 'SERVICES']).default('ALL'),
    ids: z.array(z.string()).default([]),
  }).optional(),
  notifyAt: z.coerce.date().optional(),
  imageUrl: z.string().trim().max(500).optional(),
  terms: z.string().trim().max(4000).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

/** Merchant promotion management (§6). Mounted at /api/v1/promotions. */
export const promotionsRoutes = Router();
promotionsRoutes.use(authenticate, requireTenant);

promotionsRoutes.get(
  '/',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await promotionEngine.list(req.auth!.organizationId as string) });
  })
);

promotionsRoutes.put(
  '/',
  requirePermission('marketing.update'),
  validate({ body: promotionSchema }),
  wrap(async (req, res) => {
    const data = await promotionEngine.upsert(req.auth!.organizationId as string, req.body);
    res.json({ success: true, data });
  })
);

promotionsRoutes.post(
  '/:id/status',
  requirePermission('marketing.update'),
  validate({ body: z.object({ status: z.enum(['SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED']) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await promotionEngine.setStatus(req.params.id as string, req.body.status) });
  })
);

/** Campaign performance for the business (§14). */
promotionsRoutes.get(
  '/analytics',
  requirePermission('marketing.read', 'analytics.view'),
  validate({ query: z.object({ promotionId: z.string().trim().optional() }) }),
  wrap(async (req, res) => {
    const data = await promotionEngine.analytics(
      req.auth!.organizationId as string,
      req.query.promotionId as string | undefined
    );
    res.json({ success: true, data });
  })
);
