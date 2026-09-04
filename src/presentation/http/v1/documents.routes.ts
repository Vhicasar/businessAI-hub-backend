import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { documentQrService } from '../../../application/documents/document-qr.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const documentsRoutes = Router();
documentsRoutes.use(authenticate, requireTenant);

/**
 * Resolve a scanned QR code.
 *
 * Deliberately gated on nothing more than being a signed-in member of the
 * business: scanning is how you find out *what* you are holding, and the
 * response says which of the offered actions you may actually take. Gating the
 * lookup itself behind a specific permission would mean an operator could not
 * even read the job card in front of them.
 */
documentsRoutes.post(
  '/scan',
  validate({ body: z.object({ code: z.string().trim().min(1).max(300) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await documentQrService.resolve(req.body.code) });
  }),
);

/** The printable code for a production order's job card. */
documentsRoutes.get(
  '/production-order/:id/scan-code',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await documentQrService.productionOrderPayload(req.params.id as string) });
  }),
);

/** The printable code for a maintenance work order sheet. */
documentsRoutes.get(
  '/work-order/:id/scan-code',
  requirePermission('maintenance.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await documentQrService.workOrderPayload(req.params.id as string) });
  }),
);
