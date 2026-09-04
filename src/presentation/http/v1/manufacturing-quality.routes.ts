import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { requireModule } from '../middleware/require-module';

import {
  batchesService,
  listBatchesSchema,
} from '../../../application/manufacturing/batches.service';
import {
  concludeInspectionSchema,
  createInspectionSchema,
  qualityControlService,
  qualityParameterSchema,
  recordResultsSchema,
} from '../../../application/manufacturing/quality-control.service';
import {
  holdBatchSchema,
  quarantineDecisionSchema,
  quarantineService,
} from '../../../application/manufacturing/quarantine.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Batches, quality control and quarantine.
 *
 * Kept apart from the production routes because the people are different: a QC
 * officer inspects and decides what may be released without being able to
 * start a run, and a production manager runs the line without being able to
 * pass their own output. Separate files make that separation obvious rather
 * than something you have to read the permissions to notice.
 */
export const manufacturingQualityRoutes = Router();
manufacturingQualityRoutes.use(authenticate, requireTenant, requireModule('manufacturing'));

// ── Batches ────────────────────────────────────────────────────────────────
manufacturingQualityRoutes.get(
  '/batches',
  requirePermission('production.read', 'qc.read', 'inventory.read'),
  validate({ query: listBatchesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await batchesService.list(req.query as never) });
  }),
);

manufacturingQualityRoutes.get(
  '/batches/:id',
  requirePermission('production.read', 'qc.read', 'inventory.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await batchesService.get(req.params.id as string) });
  }),
);

/**
 * The whole chain behind a batch.
 *
 * The screen somebody opens during a recall, so it is readable by anyone who
 * can see stock at all — narrowing it to QC would mean the warehouse manager
 * pulling the pallets cannot see why.
 */
manufacturingQualityRoutes.get(
  '/batches/:id/trace',
  requirePermission('production.read', 'qc.read', 'inventory.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await batchesService.trace(req.params.id as string) });
  }),
);

/** The other direction: a supplier lot went bad — what did we make with it? */
manufacturingQualityRoutes.get(
  '/lots/:lotNumber/affected',
  requirePermission('production.read', 'qc.read', 'inventory.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await batchesService.affectedBy(req.params.lotNumber as string),
    });
  }),
);

// ── Quality parameters ─────────────────────────────────────────────────────
manufacturingQualityRoutes.get(
  '/products/:productId/quality-parameters',
  requirePermission('qc.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await qualityControlService.listParameters(req.params.productId as string),
    });
  }),
);

manufacturingQualityRoutes.post(
  '/quality-parameters',
  requirePermission('qc.inspect'),
  validate({ body: qualityParameterSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await qualityControlService.createParameter(req.body) });
  }),
);

manufacturingQualityRoutes.delete(
  '/quality-parameters/:id',
  requirePermission('qc.inspect'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await qualityControlService.deleteParameter(req.params.id as string),
    });
  }),
);

// ── Inspections ────────────────────────────────────────────────────────────
manufacturingQualityRoutes.get(
  '/inspections',
  requirePermission('qc.read'),
  validate({
    query: z.object({
      status: z.enum(['PENDING', 'PASSED', 'FAILED', 'CONDITIONAL']).optional(),
      batchId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await qualityControlService.list(req.query as never) });
  }),
);

manufacturingQualityRoutes.get(
  '/inspections/:id',
  requirePermission('qc.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await qualityControlService.get(req.params.id as string) });
  }),
);

manufacturingQualityRoutes.post(
  '/inspections',
  requirePermission('qc.inspect'),
  validate({ body: createInspectionSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await qualityControlService.create(req.body, req.auth!.userId),
    });
  }),
);

manufacturingQualityRoutes.post(
  '/inspections/:id/results',
  requirePermission('qc.inspect'),
  validate({ body: recordResultsSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await qualityControlService.recordResults(req.params.id as string, req.body),
    });
  }),
);

/**
 * Conclude — and move the stock with it.
 *
 * Approving and rejecting are separate permissions in the catalogue and both
 * accepted here, because the endpoint is one decision with two outcomes and
 * the service refuses a pass over a failed reading regardless.
 */
manufacturingQualityRoutes.post(
  '/inspections/:id/conclude',
  requirePermission('qc.approve', 'qc.reject'),
  validate({ body: concludeInspectionSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await qualityControlService.conclude(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);

// ── Quarantine ─────────────────────────────────────────────────────────────
manufacturingQualityRoutes.get(
  '/quarantine',
  requirePermission('qc.read', 'inventory.read'),
  validate({
    query: z.object({
      status: z.enum(['HELD', 'RELEASED', 'REJECTED', 'REWORK', 'DISPOSED']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await quarantineService.list(req.query as never) });
  }),
);

manufacturingQualityRoutes.post(
  '/batches/:id/quarantine',
  requirePermission('qc.quarantine'),
  validate({ body: holdBatchSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await quarantineService.holdBatch(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);

/**
 * Decide what happens to held stock.
 *
 * `qc.release` specifically: letting stock that failed an inspection back out
 * is the decision somebody has to answer for, and it is not the same right as
 * being able to hold it in the first place.
 */
manufacturingQualityRoutes.post(
  '/quarantine/:id/decide',
  requirePermission('qc.release'),
  validate({ body: quarantineDecisionSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await quarantineService.decide(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);
