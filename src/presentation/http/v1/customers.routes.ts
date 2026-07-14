import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { enforceLimit } from '../middleware/plan-guard';
import { customersService } from '../../../application/customers/customers.service';
import {
  addressSchema,
  createCustomerSchema,
  listCustomersSchema,
  updateCustomerSchema,
} from '../../../application/customers/customers.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const customersRoutes = Router();

customersRoutes.use(authenticate, requireTenant);

customersRoutes.get(
  '/',
  requirePermission('customers.read'),
  validate({ query: listCustomersSchema }),
  wrap(async (req, res) => {
    const data = await customersService.list(req.query as never);
    res.json({ success: true, data });
  })
);

customersRoutes.post(
  '/',
  requirePermission('customers.create'),
  enforceLimit('contacts'),
  validate({ body: createCustomerSchema }),
  wrap(async (req, res) => {
    const data = await customersService.create(req.body);
    res.status(201).json({ success: true, data });
  })
);

customersRoutes.get(
  '/:id',
  requirePermission('customers.read'),
  wrap(async (req, res) => {
    const data = await customersService.get(req.params.id as string);
    res.json({ success: true, data });
  })
);

customersRoutes.patch(
  '/:id',
  requirePermission('customers.update'),
  validate({ body: updateCustomerSchema }),
  wrap(async (req, res) => {
    const data = await customersService.update(req.params.id as string, req.body);
    res.json({ success: true, data });
  })
);

customersRoutes.delete(
  '/:id',
  requirePermission('customers.delete'),
  wrap(async (req, res) => {
    await customersService.remove(req.params.id as string);
    res.json({ success: true, data: { message: 'Customer deleted' } });
  })
);

customersRoutes.post(
  '/:id/addresses',
  requirePermission('customers.update'),
  validate({ body: addressSchema }),
  wrap(async (req, res) => {
    const data = await customersService.addAddress(req.params.id as string, req.body);
    res.status(201).json({ success: true, data });
  })
);

customersRoutes.put(
  '/:id/addresses/:addressId',
  requirePermission('customers.update'),
  validate({ body: addressSchema }),
  wrap(async (req, res) => {
    const data = await customersService.updateAddress(
      req.params.id as string,
      req.params.addressId as string,
      req.body
    );
    res.json({ success: true, data });
  })
);

customersRoutes.delete(
  '/:id/addresses/:addressId',
  requirePermission('customers.update'),
  wrap(async (req, res) => {
    await customersService.removeAddress(req.params.id as string, req.params.addressId as string);
    res.json({ success: true, data: { message: 'Address removed' } });
  })
);
