import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { analyzeCsv, ENTITIES, exportEntity, importEntity, type Entity } from '../../../application/data-transfer/data-transfer.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const dataTransferRoutes = Router();
dataTransferRoutes.use(authenticate, requireTenant);

/** Each entity is gated by the permission that owns its data. */
const PERMS: Record<Entity, { read: string[]; write: string[] }> = {
  customers: { read: ['customers.read'], write: ['customers.create'] },
  leads: { read: ['crm.read'], write: ['crm.create'] },
  employees: { read: ['employees.read'], write: ['employees.create'] },
  products: { read: ['catalog.read'], write: ['catalog.create'] },
  'kb-articles': { read: ['support.read'], write: ['support.update'] },
  suppliers: { read: ['suppliers.read'], write: ['suppliers.create'] },
  'supplier-products': { read: ['suppliers.read'], write: ['suppliers.manage_products'] },
  'purchase-orders': { read: ['purchasing.read'], write: ['purchasing.create'] },
  // Reorder levels live on stock, so they follow the inventory permission.
  'reorder-levels': { read: ['inventory.read'], write: ['inventory.set_reorder_levels'] },
  warehouses: { read: ['inventory.read'], write: ['inventory.manage_warehouses'] },
  // Loading opening stock is an adjustment like any other, and is written to
  // the ledger as one.
  'stock-levels': { read: ['inventory.read'], write: ['inventory.adjust'] },
};

const analyzeBody = z.object({ csv: z.string().min(1).max(20_000_000) });
const importBody = z.object({
  csv: z.string().min(1).max(20_000_000),
  /** column index → target field key (null/omitted = ignore the column). */
  mapping: z.record(z.string(), z.string().nullable()).optional(),
});

/** JSON object keys arrive as strings — normalise to numeric column indexes. */
function toMapping(raw: Record<string, string | null> | undefined) {
  if (!raw) return undefined;
  const out: Record<number, string | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    const i = Number(k);
    if (Number.isInteger(i)) out[i] = v;
  }
  return out;
}

dataTransferRoutes.get(
  '/entities',
  wrap(async (_req, res) => {
    res.json({ success: true, data: ENTITIES });
  })
);

// Routes are declared per entity so permissions are enforced statically.
for (const entity of ENTITIES) {
  const perms = PERMS[entity];

  dataTransferRoutes.get(
    `/export/${entity}`,
    requirePermission(...perms.read),
    wrap(async (_req, res) => {
      const { filename, csv } = await exportEntity(entity);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    })
  );

  // Preview + suggested mapping. Read-only: nothing is written.
  dataTransferRoutes.post(
    `/analyze/${entity}`,
    requirePermission(...perms.write),
    validate({ body: analyzeBody }),
    wrap(async (req, res) => {
      res.json({ success: true, data: analyzeCsv(entity, req.body.csv) });
    })
  );

  dataTransferRoutes.post(
    `/import/${entity}`,
    requirePermission(...perms.write),
    validate({ body: importBody }),
    wrap(async (req, res) => {
      res.json({ success: true, data: await importEntity(entity, req.body.csv, toMapping(req.body.mapping)) });
    })
  );
}
