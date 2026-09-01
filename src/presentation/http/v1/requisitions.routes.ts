import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  approveRequisitionSchema,
  createRequisitionSchema,
  dispatchSchema,
  receiveRequisitionSchema,
  requisitionsService,
} from '../../../application/inventory/requisitions.service';

/**
 * Internal requisitions: one warehouse asking another for stock.
 *
 * Permissions follow who actually does each step — a branch raises the request,
 * the source warehouse agrees and sends, the destination receives. They are
 * enforced here as well as in the app, because the endpoints are reachable
 * without it.
 */
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const requisitionsRoutes = Router();
requisitionsRoutes.use(authenticate, requireTenant);

requisitionsRoutes.get(
  '/',
  requirePermission('inventory.read'),
  validate({
    query: z.object({
      status: z.string().optional(),
      warehouseId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.list(req.query as never) });
  }),
);

/** Stock the source warehouse can actually spare, for the request screen. */
requisitionsRoutes.get(
  '/availability',
  requirePermission('inventory.read'),
  validate({
    query: z.object({
      fromWarehouseId: z.string().min(1),
      variantIds: z.string().min(1),
    }),
  }),
  wrap(async (req, res) => {
    const ids = String(req.query.variantIds).split(',').map((v) => v.trim()).filter(Boolean);
    res.json({
      success: true,
      data: await requisitionsService.availability(String(req.query.fromWarehouseId), ids),
    });
  }),
);

/** Open a requisition by the QR on its paperwork. */
requisitionsRoutes.get(
  '/scan/:token',
  requirePermission('inventory.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.byScanToken(req.params.token as string) });
  }),
);

requisitionsRoutes.get(
  '/scan/:token/receiving-view',
  requirePermission('inventory.requisition_receive', 'inventory.read'),
  wrap(async (req, res) => {
    const r = await requisitionsService.byScanToken(req.params.token as string);
    res.json({ success: true, data: await requisitionsService.receivingView(r.id) });
  }),
);

requisitionsRoutes.get(
  '/:id',
  requirePermission('inventory.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.byId(req.params.id as string) });
  }),
);

requisitionsRoutes.get(
  '/:id/receiving-view',
  requirePermission('inventory.requisition_receive', 'inventory.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.receivingView(req.params.id as string) });
  }),
);

requisitionsRoutes.post(
  '/',
  requirePermission('inventory.requisition_create'),
  validate({ body: createRequisitionSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await requisitionsService.create(req.body) });
  }),
);

requisitionsRoutes.post(
  '/:id/submit',
  requirePermission('inventory.requisition_create'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.submit(req.params.id as string) });
  }),
);

/** Agreeing to supply — the source warehouse's decision. */
requisitionsRoutes.post(
  '/:id/approve',
  requirePermission('inventory.requisition_approve'),
  validate({ body: approveRequisitionSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.approve(req.params.id as string, req.body) });
  }),
);

requisitionsRoutes.post(
  '/:id/reject',
  requirePermission('inventory.requisition_approve'),
  validate({ body: z.object({ reason: z.string().trim().min(3).max(500) }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await requisitionsService.reject(req.params.id as string, req.body.reason),
    });
  }),
);

/** Stock leaves the source here, and only here. */
requisitionsRoutes.post(
  '/:id/dispatch',
  requirePermission('inventory.requisition_dispatch'),
  validate({ body: dispatchSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.dispatch(req.params.id as string, req.body) });
  }),
);

/**
 * Receive by scanning the note.
 *
 * The mobile path: the code comes from the QR, so it does not have to be typed
 * into the body as well.
 */
requisitionsRoutes.post(
  '/scan/:token/receive',
  requirePermission('inventory.requisition_receive'),
  validate({ body: receiveRequisitionSchema.omit({ scanToken: true }) }),
  wrap(async (req, res) => {
    const token = req.params.token as string;
    const r = await requisitionsService.byScanToken(token);
    res.json({
      success: true,
      data: await requisitionsService.receive(r.id, { ...req.body, scanToken: token }),
    });
  }),
);

/** Stock lands at the destination here, and only here. */
requisitionsRoutes.post(
  '/:id/receive',
  requirePermission('inventory.requisition_receive'),
  validate({ body: receiveRequisitionSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await requisitionsService.receive(req.params.id as string, req.body) });
  }),
);

requisitionsRoutes.post(
  '/:id/cancel',
  requirePermission('inventory.requisition_create'),
  validate({ body: z.object({ reason: z.string().trim().max(500).optional() }).default({}) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await requisitionsService.cancel(req.params.id as string, req.body?.reason),
    });
  }),
);
