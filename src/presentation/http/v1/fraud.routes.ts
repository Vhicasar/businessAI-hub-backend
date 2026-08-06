import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { fraudService } from '../../../application/fraud/fraud.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const listQuery = z.object({
  status: z.enum(['OPEN', 'REVIEWING', 'CONFIRMED', 'DISMISSED']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const resolveSchema = z.object({
  action: z.enum(['CONFIRMED', 'DISMISSED']),
  resolution: z.string().trim().max(500).optional(),
});

/**
 * Fraud Center — manual review queue (System Bible II Super Admin / III Fraud).
 * Mounted at /api/v1/fraud. Reuses `audit.read` (security visibility) for now;
 * dedicated `fraud.*` permissions land with the Phase 6 RBAC/ABAC pass.
 */
export const fraudRoutes = Router();

fraudRoutes.use(authenticate, requireTenant);

fraudRoutes.get(
  '/alerts',
  requirePermission('audit.read'),
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { status?: string; cursor?: string; limit: number };
    const data = await fraudService.listAlerts(q);
    res.json({ success: true, data });
  })
);

fraudRoutes.get(
  '/alerts/:id',
  requirePermission('audit.read'),
  wrap(async (req, res) => {
    const data = await fraudService.getAlert(req.params.id as string);
    res.json({ success: true, data });
  })
);

fraudRoutes.post(
  '/alerts/:id/resolve',
  requirePermission('audit.read'),
  validate({ body: resolveSchema }),
  wrap(async (req, res) => {
    const data = await fraudService.resolveAlert(req.params.id as string, req.body.action, req.body.resolution);
    res.json({ success: true, data });
  })
);
