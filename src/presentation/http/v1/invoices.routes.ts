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
  updateInvoiceSchema,
} from '../../../application/invoices/invoices.service';
import { deliveryOptions, deliverInvoice } from '../../../application/invoices/invoice-delivery.service';
import { buildInvoiceDocument } from '../../../application/invoices/invoice-document.service';

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

invoicesRoutes.patch(
  '/:id',
  requirePermission('invoices.update'),
  validate({ body: updateInvoiceSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await invoicesService.update(req.params.id as string, req.body) });
  })
);

invoicesRoutes.post(
  '/:id/send',
  requirePermission('invoices.send', 'invoices.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await invoicesService.send(req.params.id as string) });
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
  validate({
    body: z.object({
      reason: z.string().trim().max(500).optional(),
      // The caller stating they understand this invoice has taken money and
      // still want it voided. Payment records are left alone either way.
      allowPaid: z.boolean().optional(),
    }).default({}),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await invoicesService.voidInvoice(req.params.id as string, req.body ?? {}),
    });
  })
);

/**
 * The invoice as a PDF.
 *
 * The same document that gets attached to the email, so what a customer
 * receives and what the business downloads are never different files.
 */
invoicesRoutes.get(
  '/:id/pdf',
  requirePermission('invoices.read'),
  wrap(async (req, res) => {
    const doc = await buildInvoiceDocument(req.params.id as string);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Content-Length', String(doc.pdf.length));
    res.end(doc.pdf);
  })
);

/**
 * Where this invoice can be sent, and which channel is recommended.
 *
 * Separate from sending so the UI can show the choice before anything leaves
 * the building.
 */
invoicesRoutes.get(
  '/:id/delivery-options',
  requirePermission('invoices.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await deliveryOptions(req.params.id as string) });
  })
);

/** Send the invoice, on the chosen channel or the recommended one. */
invoicesRoutes.post(
  '/:id/deliver',
  requirePermission('invoices.send'),
  // Null is meaningful here: it selects the platform email fallback rather than
  // a channel the business connected.
  validate({ body: z.object({ channelAccountId: z.string().nullable().optional() }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await deliverInvoice({
        invoiceId: req.params.id as string,
        channelAccountId: req.body.channelAccountId,
      }),
    });
  })
);
