import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

/**
 * Pulls the OAuth apps this product signs businesses in through from the
 * Vhicasar Admin's service API, so Google Calendar and Calendly can be switched
 * on centrally rather than by editing each deployment's env.
 *
 * Falls back to local `GOOGLE_OAUTH_*` / `CALENDLY_OAUTH_*` env when the admin
 * has nothing configured or is unreachable — an admin outage must not
 * disconnect integrations that are already working. Mirrors
 * `billing/payment-config-sync.ts` and `ai/ai-sync.ts`.
 */

export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** Admin-supplied apps, keyed by provider. Null until the first sync. */
let override: Record<string, OAuthAppCredentials> | null = null;

export function setOAuthConfigOverride(config: Record<string, OAuthAppCredentials> | null): void {
  override = config;
}

/**
 * The credentials for a provider: the admin's app if it has one, otherwise the
 * deployment's own env.
 */
export function oauthCredentials(provider: string): OAuthAppCredentials | null {
  const remote = override?.[provider];
  if (remote?.clientId && remote.clientSecret) return remote;

  const local =
    provider === 'google_calendar'
      ? { clientId: env.oauth.google.clientId, clientSecret: env.oauth.google.clientSecret }
      : provider === 'calendly'
        ? { clientId: env.oauth.calendly.clientId, clientSecret: env.oauth.calendly.clientSecret }
        : null;

  return local?.clientId && local.clientSecret ? local : null;
}

export async function syncOAuthConfigFromAdmin(): Promise<boolean> {
  // The service API needs the shared key; without it there is nothing to ask.
  if (!env.adminCatalog.apiUrl || !env.adminCatalog.tenantSlug || !env.service.apiKey) return false;

  const url = `${env.adminCatalog.apiUrl}/api/v1/service/${env.adminCatalog.tenantSlug}/oauth-config`;
  try {
    const res = await fetch(url, {
      headers: { 'x-service-key': env.service.apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) {
      setOAuthConfigOverride(null);
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { data?: Record<string, Partial<OAuthAppCredentials>> };
    const apps = body?.data ?? {};
    const clean: Record<string, OAuthAppCredentials> = {};
    for (const [provider, creds] of Object.entries(apps)) {
      if (creds?.clientId && creds.clientSecret) {
        clean[provider] = { clientId: creds.clientId, clientSecret: creds.clientSecret };
      }
    }

    // An empty result is a real answer — clear the override so the deployment's
    // own env is used rather than a stale app the operator has since removed.
    setOAuthConfigOverride(Object.keys(clean).length ? clean : null);
    logger.info({ providers: Object.keys(clean) }, 'Synced OAuth apps from Vhicasar Admin');
    return true;
  } catch (err) {
    // Keep whatever is already loaded; losing it would break connections that
    // are working right now.
    logger.warn({ err: (err as Error).message, url }, 'OAuth app config unavailable — using local env');
    return false;
  }
}

/** Refresh periodically, so turning an integration on does not need a restart. */
export async function startOAuthConfigSync(): Promise<void> {
  await syncOAuthConfigFromAdmin();
  const intervalMin = Math.max(1, env.adminCatalog.intervalMin);
  setInterval(() => {
    void syncOAuthConfigFromAdmin();
  }, intervalMin * 60_000).unref();
}
