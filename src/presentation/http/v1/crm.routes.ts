import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  closeDealSchema,
  crmService,
  dealSchema,
  leadSchema,
  leadStatusSchema,
  listLeadsSchema,
  moveDealSchema,
} from '../../../application/crm/crm.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const crmRoutes = Router();
crmRoutes.use(authenticate, requireTenant);

// deals board
crmRoutes.get(
  '/board',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await crmService.board() });
  })
);

crmRoutes.post(
  '/deals',
  requirePermission('crm.create'),
  validate({ body: dealSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createDeal(req.body) });
  })
);

crmRoutes.post(
  '/deals/:id/move',
  requirePermission('crm.update'),
  validate({ body: moveDealSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.moveDeal(req.params.id as string, req.body.stageId),
    });
  })
);

crmRoutes.post(
  '/deals/:id/close',
  requirePermission('crm.update'),
  validate({ body: closeDealSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.closeDeal(
        req.params.id as string,
        req.body.outcome,
        req.body.lostReason
      ),
    });
  })
);

// leads
crmRoutes.get(
  '/leads',
  requirePermission('crm.read'),
  validate({ query: listLeadsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.listLeads(req.query as never) });
  })
);

crmRoutes.post(
  '/leads',
  requirePermission('crm.create'),
  validate({ body: leadSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createLead(req.body) });
  })
);

crmRoutes.patch(
  '/leads/:id/status',
  requirePermission('crm.update'),
  validate({ body: leadStatusSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.updateLeadStatus(req.params.id as string, req.body.status),
    });
  })
);

crmRoutes.post(
  '/leads/:id/convert',
  requirePermission('crm.update', 'customers.create'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.convertLead(req.params.id as string) });
  })
);
