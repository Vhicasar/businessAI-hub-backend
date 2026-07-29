import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
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
