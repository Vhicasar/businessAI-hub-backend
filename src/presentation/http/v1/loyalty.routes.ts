import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { loyaltyEngine } from '../../../application/loyalty/loyalty-engine.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const TRIGGERS = [
  'POS_SALE', 'ORDER', 'BOOKING', 'INVOICE_PAYMENT', 'WALLET_PAYMENT',
  'CARD_PAYMENT', 'BANK_TRANSFER', 'CASH_SALE', 'CAMPAIGN', 'REFERRAL',
  'MANUAL', 'BIRTHDAY', 'ANNIVERSARY', 'SIGNUP',
] as const;

const ruleSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(2).max(120),
  trigger: z.enum(TRIGGERS),
  pointsPerAmount: z.coerce.number().nonnegative().optional(),
  flatPoints: z.coerce.number().int().nonnegative().optional(),
  multiplier: z.coerce.number().positive().max(100).optional(),
  minSpend: z.coerce.number().nonnegative().optional(),
  maxPointsPerDay: z.coerce.number().int().positive().optional(),
  eligibility: z.object({
    scope: z.enum(['ALL', 'PRODUCTS', 'CATEGORIES', 'SERVICES']).default('ALL'),
    ids: z.array(z.string()).default([]),
  }).optional(),
  tier: z.string().trim().max(30).optional(),
  branchId: z.string().trim().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  priority: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Merchant loyalty configuration (§5). The programme itself already exists
 * under marketing; this exposes the *rule engine* that decides what earns.
 * Mounted at /api/v1/loyalty.
 */
export const loyaltyRoutes = Router();
loyaltyRoutes.use(authenticate, requireTenant);

loyaltyRoutes.get(
  '/rules',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    const data = await loyaltyEngine.listRules(req.auth!.organizationId as string);
    res.json({ success: true, data });
  })
);

loyaltyRoutes.put(
  '/rules',
  requirePermission('marketing.update'),
  validate({ body: ruleSchema }),
  wrap(async (req, res) => {
    const data = await loyaltyEngine.upsertRule(req.auth!.organizationId as string, req.body);
    res.json({ success: true, data });
  })
);

loyaltyRoutes.delete(
  '/rules/:id',
  requirePermission('marketing.update'),
  wrap(async (req, res) => {
    await loyaltyEngine.deleteRule(req.params.id as string);
    res.json({ success: true, data: { message: 'Rule removed' } });
  })
);

/** Manually award points (goodwill, offline promo, correction). */
loyaltyRoutes.post(
  '/award',
  requirePermission('marketing.update'),
  validate({
    body: z.object({
      customerId: z.string().trim().min(1),
      points: z.coerce.number().int().positive().optional(),
      amount: z.coerce.number().nonnegative().optional(),
      trigger: z.enum(TRIGGERS).default('MANUAL'),
      note: z.string().trim().max(200).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const organizationId = req.auth!.organizationId as string;
    // A flat manual award is expressed as a one-off rule-free grant.
    const data = await loyaltyEngine.award({
      organizationId,
      customerId: req.body.customerId,
      trigger: req.body.trigger,
      amount: req.body.amount ?? null,
      note: req.body.note,
      sourceType: 'Manual',
      sourceId: `${Date.now()}`,
    });
    res.json({ success: true, data });
  })
);

loyaltyRoutes.post(
  '/redeem',
  requirePermission('marketing.update'),
  validate({
    body: z.object({
      customerId: z.string().trim().min(1),
      points: z.coerce.number().int().positive(),
      note: z.string().trim().max(200).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await loyaltyEngine.redeem(
      req.auth!.organizationId as string,
      req.body.customerId,
      req.body.points,
      req.body.note
    );
    res.json({ success: true, data });
  })
);

loyaltyRoutes.get(
  '/customers/:customerId/statement',
  requirePermission('marketing.read'),
  validate({ query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const data = await loyaltyEngine.statement(req.params.customerId as string, q);
    res.json({ success: true, data });
  })
);
