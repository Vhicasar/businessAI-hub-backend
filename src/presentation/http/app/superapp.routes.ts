import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { rewardsService } from '../../../application/rewards/rewards.service';
import { superAppService } from '../../../application/superapp/superapp.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Customer Super App — universal profile features (loyalty, orders, timeline)
 * spanning every linked business. Mounted at /api/app/v1, `app`-scoped tokens.
 */
export const appSuperAppRoutes = Router();

appSuperAppRoutes.use(authenticateApp);

appSuperAppRoutes.get(
  '/overview',
  wrap(async (req, res) => {
    res.json({ success: true, data: await superAppService.overview(req.appAuth!.vhicasarId) });
  })
);

appSuperAppRoutes.get(
  '/loyalty',
  wrap(async (req, res) => {
    res.json({ success: true, data: await superAppService.loyalty(req.appAuth!.vhicasarId) });
  })
);

appSuperAppRoutes.get(
  '/orders',
  validate({ query: pageQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json({ success: true, data: await superAppService.orders(req.appAuth!.vhicasarId, q) });
  })
);

appSuperAppRoutes.get(
  '/timeline',
  validate({ query: pageQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json({ success: true, data: await superAppService.timeline(req.appAuth!.vhicasarId, q) });
  })
);

// ---- Universal rewards (cross-business) ----

appSuperAppRoutes.get(
  '/rewards',
  wrap(async (req, res) => {
    res.json({ success: true, data: await rewardsService.summary(req.appAuth!.vhicasarId) });
  })
);

appSuperAppRoutes.get(
  '/rewards/history',
  validate({ query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json({ success: true, data: await rewardsService.history(req.appAuth!.vhicasarId, q) });
  })
);

/** Convert points into wallet credit, spendable at any participating business. */
appSuperAppRoutes.post(
  '/rewards/redeem',
  validate({
    body: z.object({
      points: z.coerce.number().int().positive(),
      currency: z.string().trim().length(3).toUpperCase().default('NGN'),
    }),
  }),
  wrap(async (req, res) => {
    const data = await rewardsService.redeem(req.appAuth!.vhicasarId, req.body.points, req.body.currency);
    res.status(201).json({ success: true, message: 'Points redeemed.', data });
  })
);
