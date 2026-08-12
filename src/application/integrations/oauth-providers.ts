import { env } from '../../shared/config/env';
import { oauthCredentials } from './oauth-config-sync';

/**
 * OAuth providers a business connects its own account to.
 *
 * Calendar integrations cannot work on a pasted API key: Google and Calendly
 * both issue short-lived access tokens against a long-lived refresh token, and
 * the business — not the platform — owns the account. This describes each
 * provider's endpoints and response shapes so the flow around them can be
 * written once.
 */

export interface OAuthTokens {
  accessToken: string;
  /** Absent when the provider only re-issues one on re-consent. */
  refreshToken: string | null;
  /** Absolute expiry, so a token can be refreshed before it is used. */
  expiresAt: Date | null;
  scope: string | null;
}

export interface OAuthAccount {
  /** Shown in the UI so the user can see which account is connected. */
  label: string;
  /** Provider-side id, needed for subsequent API calls (e.g. Calendly URIs). */
  externalId: string | null;
}

export interface OAuthProviderDef {
  id: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  scopes: string[];
  clientId: () => string;
  clientSecret: () => string;
  configured: () => boolean;
  /** Extra params some providers require on the authorize step. */
  authorizeExtras?: Record<string, string>;
  /** Who the tokens belong to, for display and for later API calls. */
  identify: (accessToken: string) => Promise<OAuthAccount>;
}

async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  google_calendar: {
    id: 'google_calendar',
    name: 'Google Calendar',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    // Only what booking sync needs: read and write the user's own events.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    clientId: () => oauthCredentials('google_calendar')?.clientId ?? '',
    clientSecret: () => oauthCredentials('google_calendar')?.clientSecret ?? '',
    configured: () => oauthCredentials('google_calendar') !== null,
    authorizeExtras: {
      // Google only returns a refresh token on the first consent unless asked
      // explicitly — without both of these a reconnect yields no refresh token
      // and the connection silently dies an hour later.
      access_type: 'offline',
      prompt: 'consent',
    },
    async identify(accessToken) {
      const me = await getJson('https://www.googleapis.com/oauth2/v2/userinfo', accessToken);
      return { label: String(me.email ?? 'Google account'), externalId: me.id ? String(me.id) : null };
    },
  },

  calendly: {
    id: 'calendly',
    name: 'Calendly',
    authorizeUrl: 'https://auth.calendly.com/oauth/authorize',
    tokenUrl: 'https://auth.calendly.com/oauth/token',
    revokeUrl: 'https://auth.calendly.com/oauth/revoke',
    // Calendly grants the whole default scope; it takes no scope parameter.
    scopes: [],
    clientId: () => oauthCredentials('calendly')?.clientId ?? '',
    clientSecret: () => oauthCredentials('calendly')?.clientSecret ?? '',
    configured: () => oauthCredentials('calendly') !== null,
    async identify(accessToken) {
      const me = await getJson('https://api.calendly.com/users/me', accessToken);
      const resource = (me.resource ?? {}) as Record<string, unknown>;
      return {
        label: String(resource.email ?? resource.name ?? 'Calendly account'),
        // The user URI is what every other Calendly endpoint is scoped by.
        externalId: resource.uri ? String(resource.uri) : null,
      };
    },
  },
};

export function oauthProvider(id: string): OAuthProviderDef | null {
  return OAUTH_PROVIDERS[id] ?? null;
}

export function isOAuthProvider(id: string): boolean {
  return id in OAUTH_PROVIDERS;
}

/** Where the provider sends the user back. Must match the app registration. */
export function redirectUri(providerId: string): string {
  return `${env.oauth.redirectBase}/api/v1/integrations/oauth/${providerId}/callback`;
}

function toTokens(body: Record<string, unknown>): OAuthTokens {
  const expiresIn = Number(body.expires_in ?? 0);
  return {
    accessToken: String(body.access_token ?? ''),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    // A little early, so a token is never used in the second it expires.
    expiresAt: expiresIn > 0 ? new Date(Date.now() + (expiresIn - 60) * 1000) : null,
    scope: body.scope ? String(body.scope) : null,
  };
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(String(detail));
  }
  return body;
}

export function buildAuthorizeUrl(def: OAuthProviderDef, state: string): string {
  const params = new URLSearchParams({
    client_id: def.clientId(),
    redirect_uri: redirectUri(def.id),
    response_type: 'code',
    state,
    ...(def.authorizeExtras ?? {}),
  });
  if (def.scopes.length) params.set('scope', def.scopes.join(' '));
  return `${def.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(def: OAuthProviderDef, code: string): Promise<OAuthTokens> {
  return toTokens(
    await postForm(def.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      client_id: def.clientId(),
      client_secret: def.clientSecret(),
      redirect_uri: redirectUri(def.id),
    })
  );
}

export async function refreshTokens(def: OAuthProviderDef, refreshToken: string): Promise<OAuthTokens> {
  const tokens = toTokens(
    await postForm(def.tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: def.clientId(),
      client_secret: def.clientSecret(),
    })
  );
  // Google omits the refresh token on refresh; keeping the old one is what
  // makes the connection survive past the first hour.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

export async function revokeToken(def: OAuthProviderDef, token: string): Promise<void> {
  if (!def.revokeUrl) return;
  await postForm(def.revokeUrl, {
    token,
    client_id: def.clientId(),
    client_secret: def.clientSecret(),
  });
}
