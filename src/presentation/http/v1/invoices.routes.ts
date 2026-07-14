import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  createInvoiceSchema,
  invoicePaymentSchema,
  invoicesService,
  listInvoicesSchema,
} from '../../../application/invoices/invoices.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const invoicesRoutes = Router();
invoicesRoutes.use(authenticate, requireTenant);

invoicesRoutes.get(
  '/',
  requirePermission('invoices.read'),
  validate({ query: listInvoicesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await invoicesService.list(req.query as never) });
  })
);

invoicesRoutes.post(
  '/',
  requirePermission('invoices.create'),
  validate({ body: createInvoiceSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await invoicesService.createStandalone(req.body) });
  })
);

invoicesRoutes.post(
  '/from-order/:orderId',
  requirePermission('invoices.create'),
  validate({ body: z.object({ dueInDays: z.coerce.number().int().min(0).max(365).default(14) }) }),
  wrap(async (req, res) => {
    const data = await invoicesService.createFromOrder(
      req.params.orderId as string,
      req.body.dueInDays
    );
    res.status(201).json({ success: true, data });
  })
);

invoicesRoutes.get(
  '/:id',
  requirePermission('invoices.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await invoicesService.get(req.params.id as string) });
  })
);

invoicesRoutes.post(
  '/:id/payments',
  requirePermission('payments.record', 'invoices.update'),
  validate({ body: invoicePaymentSchema }),
  wrap(async (req, res) => {
    const data = await invoicesService.recordPayment(
      req.params.id as string,
      req.body,
      req.auth!.membershipId
    );
    res.status(201).json({ success: true, data });
  })
);

invoicesRoutes.post(
  '/:id/void',
  requirePermission('invoices.void'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await invoicesService.voidInvoice(req.params.id as string) });
  })
);
