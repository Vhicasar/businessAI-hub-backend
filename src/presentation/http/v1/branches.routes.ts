import { Router, type Request, type RequestHandler, type Response } from 'express';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { enforceLimit } from '../middleware/plan-guard';
import {
  branchSchema,
  branchesService,
  listBranchesSchema,
  updateBranchSchema,
} from '../../../application/branches/branches.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Branches — the physical locations a business trades from.
 *
 * `maxBranches` has been part of every plan since the pricing page was
 * written, and until now capped nothing because branches could not be created.
 * The create route carries `enforceLimit('branches')` so the advertised
 * ceiling is a real one from the first branch onwards.
 */
export const branchesRoutes = Router();
branchesRoutes.use(authenticate, requireTenant);

branchesRoutes.get(
  '/',
  requirePermission('branches.read'),
  validate({ query: listBranchesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await branchesService.list(req.query as never) });
  }),
);

branchesRoutes.get(
  '/:id',
  requirePermission('branches.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await branchesService.get(req.params.id as string) });
  }),
);

branchesRoutes.post(
  '/',
  requirePermission('branches.create'),
  // Refuses before the handler runs when the plan's branch allowance is used
  // up, so the business is told rather than quietly given a branch it is not
  // entitled to.
  enforceLimit('branches'),
  validate({ body: branchSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await branchesService.create(req.body) });
  }),
);

branchesRoutes.patch(
  '/:id',
  requirePermission('branches.update'),
  validate({ body: updateBranchSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await branchesService.update(req.params.id as string, req.body),
    });
  }),
);

/**
 * Closing a branch, not deleting it.
 *
 * Staff, warehouses and departments all carry a branch id; removing the row
 * would leave those pointing at nothing. A branch with anything attached is
 * archived, one with nothing attached is removed, and the response says which
 * happened.
 */
branchesRoutes.post(
  '/:id/close',
  requirePermission('branches.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await branchesService.archive(req.params.id as string) });
  }),
);

branchesRoutes.post(
  '/:id/reopen',
  requirePermission('branches.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await branchesService.reopen(req.params.id as string) });
  }),
);
