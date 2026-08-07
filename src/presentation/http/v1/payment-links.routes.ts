import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { documentPayment, documentQrSchema } from '../../../application/payments/document-payment.service';
import {
  paymentLinksService,
  createPaymentLinkSchema,
  sharePaymentLinkSchema,
} from '../../../application/payments/payment-links.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const listSchema = z.object({
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  status: z.string().optional(),
  customerId: z.string().optional(),
});

/** Authenticated management of payment links. */
export const paymentLinksRoutes = Router();
paymentLinksRoutes.use(authenticate, requireTenant);

paymentLinksRoutes.get(
  '/',
  requirePermission('payment_links.read'),
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.list(req.query as never) });
  }),
);

paymentLinksRoutes.post(
  '/',
  requirePermission('payment_links.create'),
  validate({ body: createPaymentLinkSchema }),
  wrap(async (req, res) => {
    const data = await paymentLinksService.create(req.body, req.auth?.membershipId ?? null);
    res.status(201).json({ success: true, data });
  }),
);

// ---- Pay codes printed on documents ----
//
// Declared before `/:id`. Express matches in declaration order, so a literal
// path that sits after a parameter route is never reached — `/document-qr`
// would be read as a link id and 404.

/**
 * The pay code for one document — invoice, receipt or rent demand.
 *
 * Read-only from the caller's point of view, but it mints the payment link on
 * first use, which is why it needs `payment_links.create` rather than a read
 * permission: printing a bill with a code on it is issuing a way to be paid.
 */
paymentLinksRoutes.get(
  '/document-qr',
  requirePermission('payment_links.create'),
  validate({ query: documentQrSchema }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { resourceType: 'ORDER' | 'INVOICE'; resourceId: string };
    res.json({ success: true, data: await documentPayment.qrFor(q.resourceType, q.resourceId) });
  })
);

/** Whether documents carry a pay code at all. */
paymentLinksRoutes.get(
  '/document-qr/setting',
  requirePermission('payment_links.read', 'invoices.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await documentPayment.getSetting() });
  })
);

paymentLinksRoutes.put(
  '/document-qr/setting',
  requirePermission('settings.manage_org'),
  validate({ body: z.object({ paymentQrOnDocuments: z.boolean() }) }),
  wrap(async (req, res) => {
    const data = await documentPayment.setSetting(req.body.paymentQrOnDocuments);
    res.json({
      success: true,
      message: data.paymentQrOnDocuments
        ? 'New documents will carry a pay code.'
        : 'New documents will not carry a pay code. Codes already sent out keep working.',
      data,
    });
  })
);

paymentLinksRoutes.get(
  '/:id',
  requirePermission('payment_links.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.get(req.params.id as string) });
  }),
);

paymentLinksRoutes.post(
  '/:id/cancel',
  requirePermission('payment_links.cancel'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.cancel(req.params.id as string) });
  }),
);

/** Share the link with its customer (email/sms/whatsapp/web-chat) or copy. */
paymentLinksRoutes.post(
  '/:id/share',
  requirePermission('payment_links.share'),
  validate({ body: sharePaymentLinkSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.share(req.params.id as string, req.body) });
  }),
);
