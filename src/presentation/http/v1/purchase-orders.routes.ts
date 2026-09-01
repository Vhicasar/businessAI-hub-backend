import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  listPurchaseOrdersSchema,
  purchaseOrderSchema,
  purchaseOrdersService,
  receiveSchema,
  updatePurchaseOrderSchema,
} from '../../../application/purchasing/purchase-orders.service';
import { reorderPolicySchema, reorderService } from '../../../application/purchasing/reorder.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Purchase orders and automatic reordering. Mounted at /api/v1/purchase-orders.
 *
 * Receiving is gated on `purchasing.receive` rather than `purchasing.update`,
 * because booking a delivery in moves stock — a warehouse hand needs it, and
 * someone who only drafts orders should not have it.
 */
export const purchaseOrdersRoutes = Router();
purchaseOrdersRoutes.use(authenticate, requireTenant);

purchaseOrdersRoutes.get(
  '/',
  requirePermission('purchasing.read'),
  validate({ query: listPurchaseOrdersSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.list(req.query as never) });
  })
);

purchaseOrdersRoutes.get(
  '/summary',
  requirePermission('purchasing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.summary() });
  })
);

// ---- Reorder policy + suggestions (before /:id so the words aren't ids) ----

purchaseOrdersRoutes.get(
  '/reorder/policy',
  requirePermission('purchasing.read', 'inventory.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await reorderService.getPolicy() });
  })
);

purchaseOrdersRoutes.put(
  '/reorder/policy',
  requirePermission('purchasing.configure_reorder'),
  validate({ body: reorderPolicySchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await reorderService.setPolicy(req.body) });
  })
);

/** What is currently below its reorder point, and what would be ordered. */
purchaseOrdersRoutes.get(
  '/reorder/shortfalls',
  requirePermission('purchasing.read', 'inventory.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await reorderService.shortfalls() });
  })
);

/** Run the sweep now, whether or not the schedule is on. */
purchaseOrdersRoutes.post(
  '/reorder/run',
  requirePermission('purchasing.create'),
  wrap(async (req, res) => {
    const data = await reorderService.run(req.auth!.organizationId as string, {
      actorUserId: req.auth!.userId,
      force: true,
    });
    res.json({
      success: true,
      message:
        data.created.length > 0
          ? `Raised ${data.created.length} purchase order(s): ${data.created.join(', ')}.`
          : 'Nothing needed reordering.',
      data,
    });
  })
);

purchaseOrdersRoutes.patch(
  '/reorder/levels/:stockLevelId',
  requirePermission('inventory.set_reorder_levels', 'inventory.adjust'),
  validate({
    body: z.object({
      reorderPoint: z.coerce.number().nonnegative().nullable(),
      reorderQty: z.coerce.number().positive().nullable(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await reorderService.setReorderLevel(req.params.stockLevelId as string, req.body);
    res.json({ success: true, data });
  })
);

// ---- Scanning (before /:id so "scan" isn't read as an order id) ----

/**
 * Resolve a scanned purchase-order QR. Read-only: the scanner shows what the
 * order is and what is still outstanding before anything is committed.
 */
purchaseOrdersRoutes.get(
  '/scan/:token',
  requirePermission('purchasing.read', 'purchasing.receive'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.byScanToken(req.params.token as string) });
  })
);

/** Expected vs received for a scanned order — a read, before anything moves. */
purchaseOrdersRoutes.get(
  '/scan/:token/receiving-view',
  requirePermission('purchasing.receive', 'purchasing.read'),
  wrap(async (req, res) => {
    const po = await purchaseOrdersService.byScanToken(req.params.token as string);
    res.json({ success: true, data: await purchaseOrdersService.receivingView(po.id) });
  })
);

/** Everything the warehouse needs to receive this order, by id. */
purchaseOrdersRoutes.get(
  '/:id/receiving-view',
  requirePermission('purchasing.receive', 'purchasing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.receivingView(req.params.id as string) });
  })
);

/** Receive a scanned order straight into stock. */
purchaseOrdersRoutes.post(
  '/scan/:token/receive',
  requirePermission('purchasing.receive'),
  validate({ body: receiveSchema }),
  wrap(async (req, res) => {
    const po = await purchaseOrdersService.byScanToken(req.params.token as string);
    const data = await purchaseOrdersService.receive(po.id, req.body, req.auth!.userId);
    res.json({
      success: true,
      message:
        data.status === 'RECEIVED'
          ? `${data.number} received in full — stock updated.`
          : `${data.number} partly received — stock updated.`,
      data,
    });
  })
);

// ---- Orders ----

purchaseOrdersRoutes.get(
  '/:id',
  requirePermission('purchasing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.get(req.params.id as string) });
  })
);

purchaseOrdersRoutes.post(
  '/',
  requirePermission('purchasing.create'),
  validate({ body: purchaseOrderSchema }),
  wrap(async (req, res) => {
    const data = await purchaseOrdersService.create(req.body, req.auth!.userId);
    res.status(201).json({ success: true, data });
  })
);

purchaseOrdersRoutes.patch(
  '/:id',
  requirePermission('purchasing.update'),
  validate({ body: updatePurchaseOrderSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.update(req.params.id as string, req.body) });
  })
);

/** Commit the order to the supplier. */
purchaseOrdersRoutes.post(
  '/:id/place',
  requirePermission('purchasing.update'),
  wrap(async (req, res) => {
    const data = await purchaseOrdersService.place(req.params.id as string, req.auth!.userId);
    res.json({ success: true, message: `${data.number} sent to ${data.supplier.name}.`, data });
  })
);

purchaseOrdersRoutes.post(
  '/:id/cancel',
  requirePermission('purchasing.update'),
  validate({ body: z.object({ reason: z.string().trim().max(300).optional() }) }),
  wrap(async (req, res) => {
    const data = await purchaseOrdersService.cancel(
      req.params.id as string,
      req.body.reason,
      req.auth!.userId
    );
    res.json({ success: true, message: `${data.number} cancelled.`, data });
  })
);

/** Book a delivery in. This is the only place stock moves in this flow. */
purchaseOrdersRoutes.post(
  '/:id/receive',
  requirePermission('purchasing.receive'),
  validate({ body: receiveSchema }),
  wrap(async (req, res) => {
    const data = await purchaseOrdersService.receive(
      req.params.id as string,
      req.body,
      req.auth!.userId
    );
    res.json({
      success: true,
      message:
        data.status === 'RECEIVED'
          ? `${data.number} received in full — stock updated.`
          : `${data.number} partly received — stock updated.`,
      data,
    });
  })
);

purchaseOrdersRoutes.delete(
  '/:id',
  requirePermission('purchasing.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await purchaseOrdersService.remove(req.params.id as string) });
  })
);
