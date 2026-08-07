import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  listSuppliersSchema,
  supplierContactSchema,
  supplierProductSchema,
  supplierSchema,
  suppliersService,
  updateSupplierProductSchema,
  updateSupplierSchema,
} from '../../../application/purchasing/suppliers.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Supplier management. Mounted at /api/v1/suppliers.
 *
 * Reads allow `catalog.read` as well as the supplier keys, because the product
 * page shows who supplies an item and a catalogue manager with no buying rights
 * still needs to see that.
 */
export const suppliersRoutes = Router();
suppliersRoutes.use(authenticate, requireTenant);

suppliersRoutes.get(
  '/',
  requirePermission('suppliers.read', 'purchasing.read', 'catalog.read'),
  validate({ query: listSuppliersSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.list(req.query as never) });
  })
);

suppliersRoutes.get(
  '/summary',
  requirePermission('suppliers.read', 'purchasing.read', 'catalog.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await suppliersService.summary() });
  })
);

/** Suppliers for one product — used by the catalog page and reorder flow. */
suppliersRoutes.get(
  '/by-product/:productId',
  requirePermission('suppliers.read', 'purchasing.read', 'catalog.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.forProduct(req.params.productId as string) });
  })
);

suppliersRoutes.get(
  '/:id',
  requirePermission('suppliers.read', 'purchasing.read', 'catalog.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.get(req.params.id as string) });
  })
);

suppliersRoutes.post(
  '/',
  requirePermission('suppliers.create'),
  validate({ body: supplierSchema }),
  wrap(async (req, res) => {
    const data = await suppliersService.create(req.body);
    res.status(201).json({
      success: true,
      // Say so when a name that was deleted brought the old record back, rather
      // than letting its purchase-order history reappear unexplained.
      message: data.restored
        ? `${data.name} was restored, along with everything previously recorded against it.`
        : undefined,
      data,
    });
  })
);

/** Bring an archived or deleted supplier back into the working list. */
suppliersRoutes.post(
  '/:id/restore',
  requirePermission('suppliers.update'),
  wrap(async (req, res) => {
    const data = await suppliersService.restore(req.params.id as string);
    res.json({ success: true, message: `${data.name} restored.`, data });
  })
);

suppliersRoutes.patch(
  '/:id',
  requirePermission('suppliers.update'),
  validate({ body: updateSupplierSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.update(req.params.id as string, req.body) });
  })
);

suppliersRoutes.delete(
  '/:id',
  requirePermission('suppliers.delete'),
  wrap(async (req, res) => {
    const data = await suppliersService.remove(req.params.id as string);
    res.json({
      success: true,
      message: data.archived
        ? 'Supplier archived — it still has purchase orders on file.'
        : 'Supplier deleted.',
      data,
    });
  })
);

// ---- Contacts ----

suppliersRoutes.post(
  '/:id/contacts',
  requirePermission('suppliers.update'),
  validate({ body: supplierContactSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await suppliersService.addContact(req.params.id as string, req.body) });
  })
);

suppliersRoutes.patch(
  '/contacts/:contactId',
  requirePermission('suppliers.update'),
  validate({ body: supplierContactSchema.partial() }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.updateContact(req.params.contactId as string, req.body) });
  })
);

suppliersRoutes.delete(
  '/contacts/:contactId',
  requirePermission('suppliers.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.removeContact(req.params.contactId as string) });
  })
);

// ---- Product links ----

suppliersRoutes.post(
  '/:id/products',
  requirePermission('suppliers.manage_products'),
  validate({ body: supplierProductSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await suppliersService.linkProduct(req.params.id as string, req.body) });
  })
);

suppliersRoutes.patch(
  '/products/:linkId',
  requirePermission('suppliers.manage_products'),
  validate({ body: updateSupplierProductSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.updateProductLink(req.params.linkId as string, req.body) });
  })
);

suppliersRoutes.delete(
  '/products/:linkId',
  requirePermission('suppliers.manage_products'),
  validate({ params: z.object({ linkId: z.string().min(1) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await suppliersService.unlinkProduct(req.params.linkId as string) });
  })
);
