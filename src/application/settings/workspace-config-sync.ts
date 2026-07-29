import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { setWorkspaceConfigOverride, type WorkspaceConfigOverride } from './workspace-config';

/**
 * Pulls this product's workspace configuration (feature flags, communication,
 * storage, limit overrides, integration toggles) from the Vhicasar Admin's
 * authenticated service API and applies it, so these are managed centrally and
 * changes propagate to the workspace on the next tick (spec #2). Best-effort:
 * on 404/unreachable/error it keeps the built-in defaults — config sync must
 * never take the product down.
 */
interface AdminWorkspaceConfig extends WorkspaceConfigOverride {
  updatedAt?: string;
}

export async function syncWorkspaceConfigFromAdmin(): Promise<boolean> {
  if (!env.adminCatalog.enabled) return false;
  const url = `${env.adminCatalog.apiUrl}/api/v1/service/${env.adminCatalog.tenantSlug}/workspace-config`;
  try {
    const res = await fetch(url, {
      headers: { 'x-service-key': env.service.apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      setWorkspaceConfigOverride(null);
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: AdminWorkspaceConfig };
    const cfg = body?.data;
    if (!cfg) {
      setWorkspaceConfigOverride(null);
      return false;
    }
    setWorkspaceConfigOverride({
      featureFlags: cfg.featureFlags,
      communication: cfg.communication,
      storage: cfg.storage,
      limits: cfg.limits,
      integrations: cfg.integrations,
    });
    logger.info('Workspace config synced from admin');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Workspace config sync from admin failed — keeping defaults');
    return false;
  }
}

/** Initial sync (best-effort) plus periodic refresh, mirroring ai-sync. */
export async function startWorkspaceConfigSync(): Promise<void> {
  if (!env.adminCatalog.enabled) return;
  await syncWorkspaceConfigFromAdmin();
  const ms = env.adminAi.intervalMin * 60_000;
  if (ms > 0) setInterval(() => void syncWorkspaceConfigFromAdmin(), ms).unref();
}
