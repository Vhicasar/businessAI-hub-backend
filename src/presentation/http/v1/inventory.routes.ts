import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  adjustStockSchema,
  inventoryService,
  listStockSchema,
  listMovementsSchema,
  transferSchema,
  updateWarehouseSchema,
  warehouseSchema,
} from '../../../application/inventory/inventory.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const inventoryRoutes = Router();
inventoryRoutes.use(authenticate, requireTenant);

inventoryRoutes.get(
  '/warehouses',
  requirePermission('inventory.read', 'orders.create'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await inventoryService.listWarehouses() });
  })
);

inventoryRoutes.post(
  '/warehouses',
  requirePermission('inventory.manage_warehouses'),
  validate({ body: warehouseSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await inventoryService.createWarehouse(req.body) });
  })
);

inventoryRoutes.patch(
  '/warehouses/:id',
  requirePermission('inventory.manage_warehouses'),
  validate({ body: updateWarehouseSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inventoryService.updateWarehouse(req.params.id as string, req.body) });
  })
);

inventoryRoutes.post(
  '/warehouses/:id/archive',
  requirePermission('inventory.manage_warehouses'),
  validate({ body: z.object({ isActive: z.boolean() }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inventoryService.setWarehouseActive(req.params.id as string, req.body.isActive) });
  })
);

inventoryRoutes.delete(
  '/warehouses/:id',
  requirePermission('inventory.manage_warehouses'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inventoryService.deleteWarehouse(req.params.id as string) });
  })
);

// ── Transfers + movements ──────────────────────────────────────────────────
inventoryRoutes.get(
  '/transfers',
  requirePermission('inventory.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await inventoryService.listTransfers() });
  })
);

inventoryRoutes.post(
  '/transfers',
  requirePermission('inventory.adjust'),
  validate({ body: transferSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await inventoryService.createTransfer(req.body, req.auth!.userId) });
  })
);

inventoryRoutes.get(
  '/movements',
  requirePermission('inventory.read'),
  validate({ query: listMovementsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inventoryService.listMovements(req.query as never) });
  })
);

inventoryRoutes.get(
  '/stock',
  requirePermission('inventory.read'),
  validate({ query: listStockSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inventoryService.listStock(req.query as never) });
  })
);

inventoryRoutes.post(
  '/stock/adjust',
  requirePermission('inventory.adjust'),
  validate({ body: adjustStockSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await inventoryService.adjustStock(req.body, req.auth!.userId),
    });
  })
);
