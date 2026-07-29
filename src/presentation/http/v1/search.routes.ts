import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { searchService } from '../../../application/search/search.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Global search (spec #15). Any authenticated tenant member may call it — the
 * service itself gates each entity type by the caller's read permissions, so no
 * extra route-level permission is needed (and none would be correct, since the
 * result set is inherently mixed-permission).
 */
export const searchRoutes = Router();
searchRoutes.use(authenticate, requireTenant);

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  perType: z.coerce.number().int().min(1).max(20).optional(),
  types: z.string().optional(), // comma-separated entity types filter
});

searchRoutes.get(
  '/',
  validate({ query: querySchema }),
  wrap(async (req, res) => {
    const q = String(req.query.q);
    const perType = req.query.perType ? Number(req.query.perType) : undefined;
    const types = req.query.types
      ? String(req.query.types).split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
    const groups = await searchService.search(q, { perType, types: types as never });
    res.json({ success: true, data: { query: q, groups } });
  }),
);

/** The entity types this caller is allowed to search (drives the UI filters). */
searchRoutes.get(
  '/scopes',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await searchService.allowedTypes() });
  }),
);
