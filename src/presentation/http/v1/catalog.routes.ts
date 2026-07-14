import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { enforceLimit } from '../middleware/plan-guard';
import { catalogService } from '../../../application/catalog/catalog.service';
import { prisma } from '../../../infrastructure/database/prisma';
import {
  createProductSchema,
  listProductsSchema,
  namedEntitySchema,
  updateProductSchema,
  variantSchema,
} from '../../../application/catalog/catalog.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

async function orgCurrency(organizationId: string): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true },
  });
  return org?.currency ?? 'USD';
}

export const catalogRoutes = Router();
catalogRoutes.use(authenticate, requireTenant);

// products
catalogRoutes.get(
  '/products',
  requirePermission('catalog.read'),
  validate({ query: listProductsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await catalogService.listProducts(req.query as never) });
  })
);

catalogRoutes.post(
  '/products',
  requirePermission('catalog.create'),
  enforceLimit('products'),
  validate({ body: createProductSchema }),
  wrap(async (req, res) => {
    const currency = await orgCurrency(req.auth!.organizationId!);
    res.status(201).json({ success: true, data: await catalogService.createProduct(req.body, currency) });
  })
);

catalogRoutes.get(
  '/products/:id',
  requirePermission('catalog.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await catalogService.getProduct(req.params.id as string) });
  })
);

catalogRoutes.patch(
  '/products/:id',
  requirePermission('catalog.update'),
  validate({ body: updateProductSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await catalogService.updateProduct(req.params.id as string, req.body) });
  })
);

catalogRoutes.delete(
  '/products/:id',
  requirePermission('catalog.delete'),
  wrap(async (req, res) => {
    await catalogService.deleteProduct(req.params.id as string);
    res.json({ success: true, data: { message: 'Product archived' } });
  })
);

// variants
catalogRoutes.post(
  '/products/:id/variants',
  requirePermission('catalog.update'),
  validate({ body: variantSchema }),
  wrap(async (req, res) => {
    const currency = await orgCurrency(req.auth!.organizationId!);
    res
      .status(201)
      .json({ success: true, data: await catalogService.addVariant(req.params.id as string, req.body, currency) });
  })
);

catalogRoutes.put(
  '/products/:id/variants/:variantId',
  requirePermission('catalog.update'),
  validate({ body: variantSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await catalogService.updateVariant(
        req.params.id as string,
        req.params.variantId as string,
        req.body
      ),
    });
  })
);

catalogRoutes.delete(
  '/products/:id/variants/:variantId',
  requirePermission('catalog.update'),
  wrap(async (req, res) => {
    await catalogService.deleteVariant(req.params.id as string, req.params.variantId as string);
    res.json({ success: true, data: { message: 'Variant removed' } });
  })
);

// categories & brands
catalogRoutes.get(
  '/categories',
  requirePermission('catalog.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await catalogService.listCategories() });
  })
);

catalogRoutes.post(
  '/categories',
  requirePermission('catalog.create'),
  validate({ body: namedEntitySchema.extend({ parentId: z.string().nullable().optional() }) }),
  wrap(async (req, res) => {
    res
      .status(201)
      .json({ success: true, data: await catalogService.createCategory(req.body.name, req.body.parentId) });
  })
);

catalogRoutes.delete(
  '/categories/:id',
  requirePermission('catalog.delete'),
  wrap(async (req, res) => {
    await catalogService.deleteCategory(req.params.id as string);
    res.json({ success: true, data: { message: 'Category deleted' } });
  })
);

catalogRoutes.get(
  '/brands',
  requirePermission('catalog.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await catalogService.listBrands() });
  })
);

catalogRoutes.post(
  '/brands',
  requirePermission('catalog.create'),
  validate({ body: namedEntitySchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await catalogService.createBrand(req.body.name) });
  })
);

catalogRoutes.delete(
  '/brands/:id',
  requirePermission('catalog.delete'),
  wrap(async (req, res) => {
    await catalogService.deleteBrand(req.params.id as string);
    res.json({ success: true, data: { message: 'Brand deleted' } });
  })
);
