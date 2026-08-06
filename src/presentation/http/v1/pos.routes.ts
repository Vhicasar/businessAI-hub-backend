import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { posService } from '../../../application/pos/pos.service';
import {
  cashMovementSchema,
  cashSaleSchema,
  closeShiftSchema,
  createRegisterSchema,
  openShiftSchema,
  payCheckoutSchema,
  updateRegisterSchema,
} from '../../../application/pos/pos.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Point of Sale. Mounted at /api/v1/pos. Reuses the existing `orders.*`
 * permissions (POS is order-taking); dedicated `pos.*` perms land in Phase 6.
 */
export const posRoutes = Router();

posRoutes.use(authenticate, requireTenant);

// Registers
posRoutes.get(
  '/registers',
  requirePermission('orders.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await posService.listRegisters() });
  })
);
posRoutes.post(
  '/registers',
  requirePermission('orders.create'),
  validate({ body: createRegisterSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await posService.createRegister(req.body) });
  })
);
posRoutes.get(
  '/registers/:id',
  requirePermission('orders.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await posService.getRegister(req.params.id as string) });
  })
);
posRoutes.patch(
  '/registers/:id',
  requirePermission('orders.update'),
  validate({ body: updateRegisterSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await posService.updateRegister(req.params.id as string, req.body) });
  })
);

// Shifts
posRoutes.post(
  '/shifts',
  requirePermission('orders.create'),
  validate({ body: openShiftSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await posService.openShift(req.body) });
  })
);
posRoutes.get(
  '/registers/:id/shift',
  requirePermission('orders.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await posService.currentShift(req.params.id as string) });
  })
);
posRoutes.get(
  '/shifts/:id/report',
  requirePermission('orders.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await posService.shiftReport(req.params.id as string) });
  })
);
posRoutes.post(
  '/shifts/:id/cash',
  requirePermission('orders.update'),
  validate({ body: cashMovementSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await posService.addCashMovement(req.params.id as string, req.body) });
  })
);
posRoutes.post(
  '/shifts/:id/close',
  requirePermission('orders.update'),
  validate({ body: closeShiftSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await posService.closeShift(req.params.id as string, req.body) });
  })
);

// Sales
posRoutes.post(
  '/shifts/:id/cash-sale',
  requirePermission('orders.create'),
  validate({ body: cashSaleSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await posService.recordCashSale(req.params.id as string, req.body) });
  })
);
posRoutes.post(
  '/shifts/:id/checkout',
  requirePermission('orders.create'),
  validate({ body: payCheckoutSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await posService.createPayCheckout(req.params.id as string, req.body) });
  })
);
