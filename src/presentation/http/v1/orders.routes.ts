import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { ordersService } from '../../../application/orders/orders.service';
import {
  createOrderSchema,
  listOrdersSchema,
  recordPaymentSchema,
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
