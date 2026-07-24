import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { auditService, listAuditSchema } from '../../../application/audit/audit.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const auditRoutes = Router();
auditRoutes.use(authenticate, requireTenant);

auditRoutes.get(
  '/',
  requirePermission('audit.read'),
  validate({ query: listAuditSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await auditService.list(req.query as never) });
  })
);
