import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { vhicasarIdService } from '../../../application/identity/vhicasar-id.service';
import { linkCustomerSchema } from '../../../application/identity/identity.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Business Admin side of Vhicasar ID: associate one of the org's Customer
 * records with a global Vhicasar ID. Mounted at /api/v1/identity.
 * Customer identity itself is never stored per-org (Database Bible §21) — only
 * the CustomerLink association lives here.
 */
export const identityRoutes = Router();

identityRoutes.use(authenticate, requireTenant);

/** View the Vhicasar ID a customer is linked to (if any). */
identityRoutes.get(
  '/customers/:customerId',
  requirePermission('customers.read'),
  wrap(async (req, res) => {
    const data = await vhicasarIdService.getCustomerLink(req.params.customerId as string);
    res.json({ success: true, data });
  })
);

/** Link a customer to a Vhicasar ID (by public id or phone). */
identityRoutes.post(
  '/customers/:customerId/link',
  requirePermission('customers.update'),
  validate({ body: linkCustomerSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarIdService.linkCustomerToIdentity(req.params.customerId as string, req.body);
    res.status(201).json({ success: true, data });
  })
);

identityRoutes.delete(
  '/customers/:customerId/link',
  requirePermission('customers.update'),
  wrap(async (req, res) => {
    await vhicasarIdService.unlinkCustomer(req.params.customerId as string);
    res.json({ success: true, data: { message: 'Unlinked from Vhicasar ID' } });
  })
);
