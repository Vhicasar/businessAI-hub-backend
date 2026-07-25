import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { setAiConfigOverride } from '../../infrastructure/ai';

/**
 * Pulls this product's AI provider config from the Vhicasar Admin's authenticated
 * service API and applies it, so AI provider/model/key are managed centrally
 * rather than per-deployment env. Falls back to the local AI_* env when the
 * admin has nothing configured (404) or is unreachable — AI must never break
 * because the admin is down.
 */
interface AdminAiConfig {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}

export async function syncAiConfigFromAdmin(): Promise<boolean> {
  if (!env.adminAi.enabled) return false;
  const url = `${env.adminCatalog.apiUrl}/api/v1/service/${env.adminCatalog.tenantSlug}/ai-config`;
  try {
    const res = await fetch(url, {
      headers: { 'x-service-key': env.service.apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      // Nothing configured in the admin for this product — use local env.
      setAiConfigOverride(null);
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: AdminAiConfig };
    const cfg = body?.data;
    if (!cfg?.provider) {
      setAiConfigOverride(null);
      return false;
    }
    setAiConfigOverride({
      provider: cfg.provider,
      model: cfg.model,
      apiKey: cfg.apiKey ?? null,
      baseUrl: cfg.baseUrl ?? null,
    });
    logger.info(`AI config synced from admin: ${cfg.provider}/${cfg.model}`);
    return true;
  } catch (err) {
    logger.warn({ err }, 'AI config sync from admin failed — keeping local AI_* env');
    return false;
  }
}

/** Initial sync (best-effort) plus periodic refresh, mirroring plan-sync. */
export async function startAiConfigSync(): Promise<void> {
  if (!env.adminAi.enabled) return;
  // Finish the first sync before accepting AI requests. Otherwise the first
  // requests can incorrectly use a stale AI_API_KEY from the server env.
  await syncAiConfigFromAdmin();
  const ms = env.adminAi.intervalMin * 60_000;
  if (ms > 0) setInterval(() => void syncAiConfigFromAdmin(), ms).unref();
}
