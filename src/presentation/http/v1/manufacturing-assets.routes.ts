import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { requireModule } from '../middleware/require-module';

import {
  productionLineSchema,
  productionLinesService,
  updateProductionLineSchema,
} from '../../../application/manufacturing/production-lines.service';
import {
  completeWorkOrderSchema,
  equipmentSchema,
  equipmentService,
  updateEquipmentSchema,
  workOrderSchema,
} from '../../../application/manufacturing/equipment.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Production lines, equipment and maintenance.
 *
 * The physical side of the factory. Maintenance reuses the permission group
 * property maintenance already had, because servicing a filler and servicing a
 * boiler in a let flat are the same job on a different asset.
 */
export const manufacturingAssetsRoutes = Router();
manufacturingAssetsRoutes.use(authenticate, requireTenant, requireModule('manufacturing'));

// ── Production lines ───────────────────────────────────────────────────────
manufacturingAssetsRoutes.get(
  '/lines',
  requirePermission('production.read'),
  validate({
    query: z.object({
      status: z.enum(['OPERATIONAL', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'OFFLINE']).optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionLinesService.list(req.query as never) });
  }),
);

manufacturingAssetsRoutes.get(
  '/lines/:id',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionLinesService.get(req.params.id as string) });
  }),
);

manufacturingAssetsRoutes.post(
  '/lines',
  requirePermission('manufacturing.manage_settings'),
  validate({ body: productionLineSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await productionLinesService.create(req.body) });
  }),
);

/**
 * Also where a line is marked down.
 *
 * `production.start` is accepted alongside the settings permission: a
 * supervisor who can start a run has to be able to say the line has stopped,
 * without being able to reconfigure the factory.
 */
manufacturingAssetsRoutes.patch(
  '/lines/:id',
  requirePermission('manufacturing.manage_settings', 'production.start'),
  validate({ body: updateProductionLineSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionLinesService.update(req.params.id as string, req.body),
    });
  }),
);

manufacturingAssetsRoutes.post(
  '/lines/:id/retire',
  requirePermission('manufacturing.manage_settings'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionLinesService.archive(req.params.id as string) });
  }),
);

// ── Equipment ──────────────────────────────────────────────────────────────
manufacturingAssetsRoutes.get(
  '/equipment',
  requirePermission('equipment.read'),
  validate({
    query: z.object({
      status: z.enum(['OPERATIONAL', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'RETIRED']).optional(),
      productionLineId: z.string().optional(),
      /** Only machines whose next service is due or overdue. */
      dueOnly: z.coerce.boolean().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await equipmentService.list(req.query as never) });
  }),
);

manufacturingAssetsRoutes.get(
  '/equipment/:id',
  requirePermission('equipment.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await equipmentService.get(req.params.id as string) });
  }),
);

manufacturingAssetsRoutes.post(
  '/equipment',
  requirePermission('equipment.create'),
  validate({ body: equipmentSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await equipmentService.create(req.body) });
  }),
);

manufacturingAssetsRoutes.patch(
  '/equipment/:id',
  requirePermission('equipment.update'),
  validate({ body: updateEquipmentSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await equipmentService.update(req.params.id as string, req.body),
    });
  }),
);

// ── Maintenance work orders ────────────────────────────────────────────────
manufacturingAssetsRoutes.get(
  '/work-orders',
  requirePermission('maintenance.read'),
  validate({
    query: z.object({
      status: z.enum(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
      equipmentId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await equipmentService.listWorkOrders(req.query as never) });
  }),
);

manufacturingAssetsRoutes.get(
  '/work-orders/:id',
  requirePermission('maintenance.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await equipmentService.getWorkOrder(req.params.id as string) });
  }),
);

manufacturingAssetsRoutes.post(
  '/work-orders',
  requirePermission('maintenance.create'),
  validate({ body: workOrderSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await equipmentService.createWorkOrder(req.body) });
  }),
);

manufacturingAssetsRoutes.post(
  '/work-orders/:id/assign',
  requirePermission('maintenance.assign'),
  validate({ body: z.object({ employeeId: z.string().min(1) }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await equipmentService.assignWorkOrder(req.params.id as string, req.body.employeeId),
    });
  }),
);

manufacturingAssetsRoutes.post(
  '/work-orders/:id/start',
  requirePermission('maintenance.update'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await equipmentService.startWorkOrder(req.params.id as string),
    });
  }),
);

/**
 * Close the job, and take the parts out of stock.
 *
 * Atomic with the parts: a part the store cannot cover fails the whole thing,
 * rather than leaving a machine that reads as fixed and a store that never
 * gave up the bearing.
 */
manufacturingAssetsRoutes.post(
  '/work-orders/:id/complete',
  requirePermission('maintenance.complete'),
  validate({ body: completeWorkOrderSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await equipmentService.completeWorkOrder(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);
