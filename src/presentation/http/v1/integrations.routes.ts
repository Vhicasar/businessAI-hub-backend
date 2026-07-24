import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { prisma } from '../../../infrastructure/database/prisma';
import { encrypt } from '../../../shared/crypto';
import { getSiteCatalog } from '../../../application/catalog/site-catalog.service';
import { resolveEntitlements } from '../../../application/billing/entitlements';
import { NotFoundError } from '../../../shared/errors';

const wrap = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

export const integrationsRoutes = Router();
integrationsRoutes.use(authenticate, requireTenant);

integrationsRoutes.get('/', requirePermission('settings.manage_integrations'), wrap(async (_req, res) => {
  const [catalog, connected, ent] = await Promise.all([
    getSiteCatalog(),
    prisma.integrationCredential.findMany({ select: { id: true, provider: true, isActive: true, metadata: true, updatedAt: true } }),
    resolveEntitlements(),
  ]);
  const byProvider = new Map(connected.map((item) => [item.provider, item]));
  res.json({
    success: true,
    data: catalog.integrations.filter((item) => item.enabled).map((item) => ({
      ...item,
      available: item.plans.length === 0 || item.plans.includes(ent.planSlug),
      connection: byProvider.get(item.id) ?? null,
    })),
  });
}));

const connectSchema = z.object({
  credentials: z.record(z.string().max(5000)),
});

integrationsRoutes.put('/:provider', requirePermission('settings.manage_integrations'), validate({ body: connectSchema }), wrap(async (req, res) => {
  const catalog = await getSiteCatalog();
  const definition = catalog.integrations.find((item) => item.id === req.params.provider && item.enabled);
  if (!definition) throw new NotFoundError('Integration');
  const ent = await resolveEntitlements();
  if (definition.plans.length > 0 && !definition.plans.includes(ent.planSlug)) {
    res.status(403).json({ success: false, error: { code: 'PLAN_UPGRADE_REQUIRED', message: `Upgrade your plan to connect ${definition.name}.` } });
    return;
  }
  const missing = definition.fields.filter((field) => field.required && !req.body.credentials[field.key]?.trim());
  if (missing.length) {
    res.status(400).json({ success: false, error: { code: 'MISSING_CREDENTIALS', message: `Required: ${missing.map((f) => f.label).join(', ')}` } });
    return;
  }
  const row = await prisma.integrationCredential.upsert({
    where: { organizationId_provider: { organizationId: ent.organizationId, provider: definition.id } },
    update: { credentialsEnc: encrypt(JSON.stringify(req.body.credentials)), isActive: true, metadata: { name: definition.name } },
    create: { organizationId: ent.organizationId, provider: definition.id, credentialsEnc: encrypt(JSON.stringify(req.body.credentials)), metadata: { name: definition.name } },
    select: { id: true, provider: true, isActive: true, metadata: true, updatedAt: true },
  });
  res.json({ success: true, data: row });
}));

integrationsRoutes.delete('/:provider', requirePermission('settings.manage_integrations'), wrap(async (req, res) => {
  const existing = await prisma.integrationCredential.findFirst({ where: { provider: req.params.provider } });
  if (!existing) throw new NotFoundError('Integration connection');
  await prisma.integrationCredential.delete({ where: { id: existing.id } });
  res.json({ success: true, data: { disconnected: true } });
}));
