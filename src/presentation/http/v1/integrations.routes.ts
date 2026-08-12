import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { prisma } from '../../../infrastructure/database/prisma';
import { encrypt } from '../../../shared/crypto';
import { env } from '../../../shared/config/env';
import { logger } from '../../../shared/logger';
import { getSiteCatalog } from '../../../application/catalog/site-catalog.service';
import { resolveEntitlements } from '../../../application/billing/entitlements';
import { integrationAccess, integrationAccessFor } from '../../../application/integrations/integration-access';
import { oauthConnections } from '../../../application/integrations/oauth-connection.service';
import { isOAuthProvider, oauthProvider } from '../../../application/integrations/oauth-providers';
import { NotFoundError } from '../../../shared/errors';

const wrap = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

export const integrationsRoutes = Router();

/**
 * The OAuth callback is hit by the provider redirecting the user's browser, so
 * it carries no session and no tenant. It is mounted before `authenticate` and
 * authorises itself from the signed `state` instead. Declared first so the
 * router-level authenticate below cannot shadow it.
 */
integrationsRoutes.get('/oauth/:provider/callback', wrap(async (req, res) => {
  const settings = `${env.WEB_APP_URL}/settings/integrations`;
  const fail = (message: string, returnTo = settings) =>
    res.redirect(`${returnTo}?integration=${encodeURIComponent(String(req.params.provider))}&status=error&message=${encodeURIComponent(message)}`);

  // The user declining at the provider is a normal outcome, not an error.
  if (typeof req.query.error === 'string') {
    return fail(req.query.error === 'access_denied' ? 'Connection cancelled.' : String(req.query.error));
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state) return fail('The provider did not send back an authorisation code.');

  try {
    const result = await oauthConnections.completeCallback({ code, state });
    res.redirect(`${result.returnTo}?integration=${encodeURIComponent(result.provider)}&status=connected`);
  } catch (err) {
    logger.warn({ err: (err as Error).message, provider: req.params.provider }, 'oauth callback failed');
    fail((err as Error).message);
  }
}));

integrationsRoutes.use(authenticate, requireTenant);

integrationsRoutes.get('/', requirePermission('settings.manage_integrations'), wrap(async (_req, res) => {
  const [catalog, connected] = await Promise.all([
    getSiteCatalog(),
    prisma.integrationCredential.findMany({ select: { id: true, provider: true, isActive: true, metadata: true, updatedAt: true } }),
  ]);
  const enabled = catalog.integrations.filter((item) => item.enabled);
  const access = await integrationAccessFor(enabled);
  const byProvider = new Map(connected.map((item) => [item.provider, item]));

  res.json({
    success: true,
    data: enabled.map((item) => {
      const grant = access.get(item.id);
      const oauth = isOAuthProvider(item.id);
      return {
        ...item,
        auth: item.auth ?? (oauth ? 'oauth' : 'credentials'),
        available: grant?.available ?? false,
        requiredPlan: grant?.requiredPlan ?? null,
        // An OAuth integration the platform has no app registered for cannot be
        // connected by anyone; saying so beats a button that always fails.
        configurable: oauth ? Boolean(oauthProvider(item.id)?.configured()) : true,
        connection: byProvider.get(item.id) ?? null,
      };
    }),
  });
}));

const connectSchema = z.object({
  credentials: z.record(z.string().max(5000)),
});

integrationsRoutes.put('/:provider', requirePermission('settings.manage_integrations'), validate({ body: connectSchema }), wrap(async (req, res) => {
  const catalog = await getSiteCatalog();
  const definition = catalog.integrations.find((item) => item.id === req.params.provider && item.enabled);
  if (!definition) throw new NotFoundError('Integration');

  // An OAuth integration has no credentials to paste; accepting them here would
  // write a connection that cannot actually call the provider.
  if (isOAuthProvider(definition.id)) {
    res.status(400).json({
      success: false,
      error: { code: 'OAUTH_REQUIRED', message: `${definition.name} is connected by signing in, not with an API key.` },
    });
    return;
  }

  const ent = await resolveEntitlements();
  const grant = await integrationAccess(definition, ent.planSlug);
  if (!grant.available) {
    res.status(403).json({
      success: false,
      error: {
        code: 'PLAN_UPGRADE_REQUIRED',
        message: `Upgrade your plan to connect ${definition.name}.`,
        details: { requiredPlan: grant.requiredPlan },
      },
    });
    return;
  }
  const missing = definition.fields.filter((field) => field.required && !req.body.credentials[field.key]?.trim());
  if (missing.length) {
    res.status(400).json({ success: false, error: { code: 'MISSING_CREDENTIALS', message: `Required: ${missing.map((f) => f.label).join(', ')}` } });
    return;
  }
  const row = await prisma.integrationCredential.upsert({
    where: { organizationId_provider: { organizationId: ent.organizationId, provider: definition.id } },
    update: { credentialsEnc: encrypt(JSON.stringify(req.body.credentials)), isActive: true, metadata: { name: definition.name, kind: 'credentials' } },
    create: { organizationId: ent.organizationId, provider: definition.id, credentialsEnc: encrypt(JSON.stringify(req.body.credentials)), metadata: { name: definition.name, kind: 'credentials' } },
    select: { id: true, provider: true, isActive: true, metadata: true, updatedAt: true },
  });
  res.json({ success: true, data: row });
}));

/**
 * Begin an OAuth connection.
 *
 * Returns the URL rather than redirecting, because the caller is a fetch from
 * the settings screen — a 302 to Google would be followed by the XHR and land
 * nowhere the user can see.
 */
integrationsRoutes.post('/:provider/oauth/start', requirePermission('settings.manage_integrations'), wrap(async (req, res) => {
  const provider = String(req.params.provider);
  const catalog = await getSiteCatalog();
  const definition = catalog.integrations.find((item) => item.id === provider && item.enabled);
  if (!definition || !isOAuthProvider(provider)) throw new NotFoundError('Integration');

  // The same plan check the list uses, applied where it actually matters.
  const ent = await resolveEntitlements();
  const grant = await integrationAccess(definition, ent.planSlug);
  if (!grant.available) {
    res.status(403).json({
      success: false,
      error: {
        code: 'PLAN_UPGRADE_REQUIRED',
        message: `Upgrade your plan to connect ${definition.name}.`,
        details: { requiredPlan: grant.requiredPlan },
      },
    });
    return;
  }

  const returnTo = `${env.WEB_APP_URL}/settings/integrations`;
  const url = oauthConnections.startUrl({
    provider,
    organizationId: ent.organizationId,
    userId: req.auth?.userId ?? '',
    returnTo,
  });
  res.json({ success: true, data: { url } });
}));

/** Connection status, including whether it has lapsed and needs reconnecting. */
integrationsRoutes.get('/:provider/status', requirePermission('settings.manage_integrations'), wrap(async (req, res) => {
  const row = await oauthConnections.status(String(req.params.provider));
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  res.json({
    success: true,
    data: {
      connected: Boolean(row?.isActive),
      accountLabel: metadata.accountLabel ?? null,
      connectedAt: metadata.connectedAt ?? null,
      needsReauth: Boolean(metadata.needsReauth),
      lastError: metadata.lastError ?? null,
      updatedAt: row?.updatedAt ?? null,
    },
  });
}));

integrationsRoutes.delete('/:provider', requirePermission('settings.manage_integrations'), wrap(async (req, res) => {
  const provider = String(req.params.provider);
  if (isOAuthProvider(provider)) {
    // Revokes at the provider as well, so disconnecting actually withdraws the
    // grant rather than just forgetting it locally.
    const ent = await resolveEntitlements();
    await oauthConnections.disconnect(provider, ent.organizationId);
    res.json({ success: true, data: { disconnected: true } });
    return;
  }
  const existing = await prisma.integrationCredential.findFirst({ where: { provider } });
  if (!existing) throw new NotFoundError('Integration connection');
  await prisma.integrationCredential.delete({ where: { id: existing.id } });
  res.json({ success: true, data: { disconnected: true } });
}));
