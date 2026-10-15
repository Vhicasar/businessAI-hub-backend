import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { ordersService } from '../../../application/orders/orders.service';
import {
  createOrderSchema,
  listOrdersSchema,
  recordPaymentSchema,
  refundOrderSchema,
  transitionSchema,
} from '../../../application/orders/orders.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const ordersRoutes = Router();
ordersRoutes.use(authenticate, requireTenant);

ordersRoutes.get(
  '/',
  requirePermission('orders.read'),
  validate({ query: listOrdersSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await ordersService.list(req.query as never) });
  })
);

ordersRoutes.post(
  '/',
  requirePermission('orders.create'),
  validate({ body: createOrderSchema }),
  wrap(async (req, res) => {
    const data = await ordersService.create(req.body, req.auth!.membershipId);
    res.status(201).json({ success: true, data });
  })
);

ordersRoutes.get(
  '/:id',
  requirePermission('orders.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await ordersService.get(req.params.id as string) });
  })
);

/**
 * The receipt for this order, rendered the way the business configured it.
 *
 * The same document the customer's receipt link serves and the receipt email
 * carries — built on the server from the order and its payments. The order
 * screen used to assemble its own in the browser, which is how the business
 * could be looking at a complete receipt while the customer's link showed
 * nothing at all.
 */
ordersRoutes.get(
  '/:id/receipt',
  requirePermission('orders.read'),
  wrap(async (req, res) => {
    const { orderReceipt } = await import('../../../application/payments/order-receipt.service');
    res.json({ success: true, data: await orderReceipt(req.params.id as string) });
  }),
);

/**
 * Send the receipt again, or for the first time after a failure.
 *
 * A mail server being down for ten minutes should not cost a customer their
 * receipt for ever, and a business that connected its mailbox *after* the
 * payment landed needs a way to put that right.
 */
ordersRoutes.post(
  '/:id/receipt/resend',
  requirePermission('orders.fulfill'),
  wrap(async (req, res) => {
    const { resendOrderReceipt } = await import('../../../application/payments/order-receipt.service');
    res.json({ success: true, data: await resendOrderReceipt(req.params.id as string) });
  }),
);

ordersRoutes.post(
  '/:id/transition',
  requirePermission('orders.update', 'orders.fulfill'),
  validate({ body: transitionSchema }),
  wrap(async (req, res) => {
    const data = await ordersService.transition(req.params.id as string, req.body, req.auth!.userId);
    res.json({ success: true, data });
  })
);

ordersRoutes.post(
  '/:id/refund',
  requirePermission('orders.refund'),
  validate({ body: refundOrderSchema }),
  wrap(async (req, res) => {
    const data = await ordersService.refund(req.params.id as string, req.body, req.auth!.userId);
    res.json({ success: true, data });
  })
);

ordersRoutes.post(
  '/:id/payments',
  requirePermission('payments.record', 'orders.update'),
  validate({ body: recordPaymentSchema }),
  wrap(async (req, res) => {
    const data = await ordersService.recordPayment(
      req.params.id as string,
      req.body,
      req.auth!.membershipId
    );
    res.status(201).json({ success: true, data });
  })
);
