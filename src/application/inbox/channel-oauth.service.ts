import type { ChannelType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { env } from '../../shared/config/env';
import { oauthCredentials } from '../integrations/oauth-config-sync';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { signState, verifyState } from '../integrations/oauth-connection.service';

/**
 * Connecting WhatsApp, Messenger and Instagram without a Developer App.
 *
 * A business should not have to create a Meta app, generate a system-user
 * token and paste it into a settings form — that is the single biggest reason
 * these integrations go unconnected. Instead ONE Vhicasar-owned Meta app is
 * configured centrally, each business authorises it through Meta's own dialog,
 * and what comes back is a token scoped to that business alone.
 *
 * The secret never leaves the server: the browser is sent to Meta and comes
 * back with a short-lived `code`, which only this service can exchange.
 *
 * Everything provider-specific lives here and in the adapters. The rest of the
 * inbox deals in ChannelAccount rows, so replacing Meta's own APIs with an
 * aggregator later means writing another service beside this one, not
 * rewriting the inbox.
 */

const graph = () => env.meta.graphUrl;

/** Which channels can be connected by OAuth, and what each needs from Meta. */
const OAUTH_CHANNELS: Partial<Record<ChannelType, { scopes: string[]; label: string }>> = {
  WHATSAPP: {
    // WABA assets are resolved from the token's granular targets. Requiring
    // business_management merely to enumerate /me/businesses makes Embedded
    // Signup fail for otherwise valid WhatsApp-only grants.
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    label: 'WhatsApp Business',
  },
  FACEBOOK_MESSENGER: {
    scopes: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'business_management'],
    label: 'Facebook Page',
  },
  INSTAGRAM: {
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    label: 'Instagram professional account',
  },
};

/**
 * The Meta app these flows run through.
 *
 * Read at call time rather than at import, and from the admin's configured app
 * before the deployment's env — so rotating the secret in Vhicasar Admin takes
 * effect on the next connection instead of the next deploy (§15).
 */
function metaApp(): { appId: string; appSecret: string } {
  const configured = oauthCredentials('meta');
  return {
    appId: configured?.clientId || env.meta.appId,
    appSecret: configured?.clientSecret || env.meta.appSecret,
  };
}

function instagramApp(): { appId: string; appSecret: string } {
  const configured = oauthCredentials('instagram');
  return {
    appId: configured?.clientId || env.instagram.appId,
    appSecret: configured?.clientSecret || env.instagram.appSecret,
  };
}

function instagramLoginMode(): 'DIRECT_INSTAGRAM' | 'FACEBOOK_PAGE' {
  return oauthCredentials('instagram')?.loginMode === 'FACEBOOK_PAGE'
    ? 'FACEBOOK_PAGE'
    : 'DIRECT_INSTAGRAM';
}

/** Used by the application-level webhook receiver; never returned to clients. */
export const metaAppSecret = (): string => metaApp().appSecret;
export const metaWebhookAppSecret = (channelType: ChannelType): string =>
  channelType === 'INSTAGRAM' ? instagramApp().appSecret : metaApp().appSecret;

/** Whether a Meta app is configured at all, from either source. */
export function metaConfigured(): boolean {
  const { appId, appSecret } = metaApp();
  return Boolean(appId && appSecret);
}

export function supportsOAuth(channelType: ChannelType): boolean {
  return channelType in OAUTH_CHANNELS &&
    (channelType === 'INSTAGRAM' ? Boolean(instagramApp().appId && instagramApp().appSecret) : metaConfigured());
}

/** Why OAuth is unavailable, phrased for whoever has to fix it. */
export function oauthUnavailableReason(channelType: ChannelType): string | null {
  if (!(channelType in OAUTH_CHANNELS)) {
    return `${channelType} cannot be connected automatically — it is set up with its own credentials.`;
  }
  if (channelType === 'INSTAGRAM' ? !(instagramApp().appId && instagramApp().appSecret) : !metaConfigured()) {
    return 'One-click connection is not configured on this deployment yet. Connect with your own credentials, or ask your administrator to finish the Meta app setup.';
  }
  return null;
}

export const callbackUrl = (channelType: ChannelType): string =>
  `${env.API_BASE_URL}/api/v1/channels/${channelType.toLowerCase()}/callback`;

/**
 * Where to send the browser to start authorisation.
 *
 * The state carries the tenant, because the callback arrives as a plain
 * redirect with no session on it — and it is signed, so one business cannot
 * point a callback at another's organisation.
 */
export function authorizationUrl(input: {
  channelType: ChannelType;
  organizationId: string;
  userId: string;
  returnTo: string;
}): { url: string; state: string } {
  const config = OAUTH_CHANNELS[input.channelType];
  const reason = oauthUnavailableReason(input.channelType);
  if (!config || reason) {
    throw new AppError('CHANNEL_OAUTH_UNAVAILABLE', 400, reason ?? 'Not connectable.');
  }

  const state = signState({
    organizationId: input.organizationId,
    userId: input.userId,
    provider: `channel:${input.channelType}`,
    returnTo: input.returnTo,
    issuedAt: Date.now(),
  });

  const scopes = input.channelType === 'INSTAGRAM' && instagramLoginMode() === 'FACEBOOK_PAGE'
    ? ['instagram_basic', 'instagram_manage_messages', 'pages_show_list', 'pages_manage_metadata']
    : [...config.scopes];
  // Standard Facebook OAuth does not return Embedded Signup asset target ids,
  // so it needs Business Management access to enumerate /me/businesses and
  // then the selected portfolio's owned WABAs. Keep that broader permission
  // out of the Embedded Signup path, where granular targets are available.
  if (input.channelType === 'WHATSAPP' && !env.meta.whatsappConfigId) {
    scopes.push('business_management');
  }
  const app = input.channelType === 'INSTAGRAM' ? instagramApp() : metaApp();
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: callbackUrl(input.channelType),
    state,
    scope: scopes.join(','),
    response_type: 'code',
  });
  // WhatsApp uses Embedded Signup, which is the same OAuth dialog driven by a
  // configuration built in the Meta dashboard — it walks the business through
  // creating or picking a WABA and a phone number.
  if (input.channelType === 'WHATSAPP' && env.meta.whatsappConfigId) {
    params.set('config_id', env.meta.whatsappConfigId);
    params.set('override_default_response_type', 'true');
  }

  if (input.channelType === 'INSTAGRAM' && instagramLoginMode() === 'DIRECT_INSTAGRAM') {
    params.set('enable_fb_login', '0');
    params.set('force_authentication', '1');
    return { url: `${env.instagram.authBaseUrl}/oauth/authorize?${params.toString()}`, state };
  }

  return {
    url: `https://www.facebook.com/${env.meta.graphVersion}/dialog/oauth?${params.toString()}`,
    state,
  };
}

/** What the callback resolved to, ready to become a ChannelAccount. */
export interface ResolvedConnection {
  organizationId: string;
  userId: string;
  returnTo: string;
  channelType: ChannelType;
  /** Provider-side account id — phone number id, or page id. */
  externalId: string;
  /** What the business will recognise on screen. */
  displayName: string;
  /** Encrypted by the caller before storage; never returned to a browser. */
  credentials: Record<string, string>;
  metadata: Record<string, unknown>;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${graph()}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`);
  const json = (await res.json()) as T & { error?: { message?: string; type?: string } };
  if (!res.ok || json.error) {
    // Meta's own wording is for developers, not shopkeepers; the caller turns
    // this into something a business can act on.
    logger.warn({ path, error: json.error }, 'Meta Graph call failed');
    throw new AppError(
      'CHANNEL_PROVIDER_ERROR',
      502,
      json.error?.message ?? `Meta returned ${res.status}`,
    );
  }
  return json;
}

/** Swap the one-time code for a token that belongs to this business. */
async function exchangeCode(code: string, channelType: ChannelType): Promise<{ accessToken: string; expiresAt: string | null; scopes?: string[] }> {
  if (channelType === 'INSTAGRAM' && instagramLoginMode() === 'DIRECT_INSTAGRAM') return exchangeInstagramCode(code);
  const app = channelType === 'INSTAGRAM' ? instagramApp() : metaApp();
  const params = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    redirect_uri: callbackUrl(channelType),
    code,
  });
  const res = await fetch(`${graph()}/oauth/access_token?${params.toString()}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !json.access_token) {
    throw new AppError(
      'CHANNEL_OAUTH_FAILED',
      400,
      json.error?.message ?? 'Meta would not complete the connection.',
    );
  }
  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
  };
}

async function exchangeInstagramCode(code: string): Promise<{ accessToken: string; expiresAt: string | null; scopes?: string[] }> {
  const app = instagramApp();
  const body = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: callbackUrl('INSTAGRAM'),
    code,
  });
  const shortRes = await fetch(`${env.instagram.apiBaseUrl}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const short = await shortRes.json().catch(() => ({})) as { access_token?: string; permissions?: string[]; error_message?: string; error?: { message?: string } };
  if (!shortRes.ok || !short.access_token) {
    throw new AppError('INSTAGRAM_TOKEN_EXCHANGE_FAILED', 400, short.error_message ?? short.error?.message ?? 'Instagram could not exchange the authorization code.');
  }
  const granted = short.permissions;
  const required = OAUTH_CHANNELS.INSTAGRAM?.scopes ?? [];
  if (granted && required.some((scope) => !granted.includes(scope))) {
    throw new AppError('INSTAGRAM_PERMISSION_MISSING', 400, 'Instagram did not grant all required profile and messaging permissions.');
  }

  const longParams = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: app.appSecret,
    access_token: short.access_token,
  });
  const longRes = await fetch(`${env.instagram.graphBaseUrl}/access_token?${longParams.toString()}`);
  const long = await longRes.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!longRes.ok || !long.access_token) {
    throw new AppError('INSTAGRAM_TOKEN_EXCHANGE_FAILED', 400, long.error?.message ?? 'Instagram could not issue a long-lived access token.');
  }
  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
    scopes: granted ?? required,
  };
}

/**
 * Finish the flow: verify the state, exchange the code, and find out what the
 * business actually authorised.
 */
export async function completeCallback(input: {
  channelType: ChannelType;
  code: string;
  state: string;
}): Promise<ResolvedConnection> {
  let payload: ReturnType<typeof verifyState>;
  try {
    payload = verifyState(input.state);
  } catch (error) {
    if (input.channelType === 'INSTAGRAM') {
      throw new AppError('INSTAGRAM_STATE_MISMATCH', 400, 'The Instagram connection state is invalid or expired.', { cause: error });
    }
    throw error;
  }
  // The state says which channel it was issued for; a state minted for one
  // channel must not complete another.
  if (payload.provider !== `channel:${input.channelType}`) {
    throw new AppError(input.channelType === 'INSTAGRAM' ? 'INSTAGRAM_STATE_MISMATCH' : 'OAUTH_STATE_INVALID', 400, 'This connection link is for a different channel.');
  }

  const token = await exchangeCode(input.code, input.channelType);
  const base = {
    organizationId: payload.organizationId,
    userId: payload.userId,
    returnTo: payload.returnTo,
    channelType: input.channelType,
  };

  if (input.channelType === 'WHATSAPP') {
    return { ...base, ...(await resolveWhatsApp(token.accessToken, token.expiresAt)) };
  }
  if (input.channelType === 'INSTAGRAM') {
    return {
      ...base,
      ...(instagramLoginMode() === 'DIRECT_INSTAGRAM'
        ? await resolveInstagram(token.accessToken, token.expiresAt, token.scopes)
        : await resolveInstagramViaFacebook(token.accessToken, token.expiresAt)),
    };
  }
  return { ...base, ...(await resolvePage(token.accessToken, token.expiresAt)) };
}

async function resolveInstagramViaFacebook(
  userToken: string,
  tokenExpiresAt: string | null,
): Promise<Pick<ResolvedConnection, 'externalId' | 'displayName' | 'credentials' | 'metadata'>> {
  const pages = await graphGet<{
    data?: Array<{
      id: string; name?: string; access_token?: string;
      instagram_business_account?: { id: string; username?: string };
    }>;
  }>('/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}', userToken);
  const page = (pages.data ?? []).find((candidate) => candidate.instagram_business_account?.id);
  const instagram = page?.instagram_business_account;
  if (!page || !instagram || !page.access_token) {
    throw new AppError('INSTAGRAM_ACCOUNT_NOT_ELIGIBLE', 400, 'No Page-linked Instagram Professional account was available. Link the account to a Facebook Page or switch the admin setting to direct Instagram Login.');
  }
  return {
    externalId: instagram.id,
    displayName: instagram.username ? `@${instagram.username}` : 'Instagram',
    credentials: {
      pageAccessToken: page.access_token,
      pageId: page.id,
      instagramAccountId: instagram.id,
      appSecret: instagramApp().appSecret,
    },
    metadata: {
      instagramAccountId: instagram.id,
      facebookPageId: page.id,
      username: instagram.username ?? null,
      tokenExpiresAt,
      tokenType: 'bearer',
      connectedAt: new Date().toISOString(),
      connectedVia: 'facebook_page_login',
    },
  };
}

async function resolveInstagram(
  accessToken: string,
  tokenExpiresAt: string | null,
  grantedScopes: string[] = [],
): Promise<Pick<ResolvedConnection, 'externalId' | 'displayName' | 'credentials' | 'metadata'>> {
  const fields = new URLSearchParams({ fields: 'user_id,username,account_type', access_token: accessToken });
  const res = await fetch(`${env.instagram.graphUrl}/me?${fields.toString()}`);
  const profile = await res.json().catch(() => ({})) as {
    id?: string; user_id?: string; username?: string; account_type?: string; error?: { message?: string };
  };
  const accountId = profile.user_id ?? profile.id;
  if (!res.ok || !accountId) {
    throw new AppError('INSTAGRAM_PROFILE_FETCH_FAILED', 400, profile.error?.message ?? 'Instagram could not load the selected professional account.');
  }
  if (profile.account_type && !['BUSINESS', 'MEDIA_CREATOR'].includes(profile.account_type)) {
    throw new AppError('INSTAGRAM_ACCOUNT_NOT_ELIGIBLE', 400, 'Select an Instagram Business or Creator account. Personal accounts are not eligible.');
  }
  return {
    externalId: accountId,
    displayName: profile.username ? `@${profile.username}` : 'Instagram',
    credentials: { accessToken, instagramAccountId: accountId, appSecret: instagramApp().appSecret },
    metadata: {
      instagramAccountId: accountId,
      username: profile.username ?? null,
      accountType: profile.account_type ?? null,
      tokenExpiresAt,
      grantedScopes,
      tokenType: 'bearer',
      connectedAt: new Date().toISOString(),
      connectedVia: 'instagram_direct_login',
    },
  };
}

/** The WABA and phone number the business picked during Embedded Signup. */
async function resolveWhatsApp(
  userToken: string,
  tokenExpiresAt: string | null,
): Promise<Pick<ResolvedConnection, 'externalId' | 'displayName' | 'credentials' | 'metadata'>> {
  // Facebook Login for Business records the assets selected in Embedded
  // Signup as granular-scope target ids. This is both more precise and less
  // privileged than listing every Business portfolio the person administers.
  const app = metaApp();
  const debugParams = new URLSearchParams({
    input_token: userToken,
    access_token: `${app.appId}|${app.appSecret}`,
  });
  const debugRes = await fetch(`${graph()}/debug_token?${debugParams.toString()}`);
  const debug = (await debugRes.json().catch(() => ({}))) as {
    data?: { granular_scopes?: { scope?: string; target_ids?: string[] }[] };
  };
  const grantedWabaIds = debugRes.ok
    ? [...new Set(
        (debug.data?.granular_scopes ?? [])
          .filter((grant) => grant.scope === 'whatsapp_business_management' || grant.scope === 'whatsapp_business_messaging')
          .flatMap((grant) => grant.target_ids ?? []),
      )]
    : [];

  const businesses = grantedWabaIds.length
    ? { data: [] as { id: string; name?: string }[] }
    : await graphGet<{ data?: { id: string; name?: string }[] }>(
        '/me/businesses?fields=id,name',
        userToken,
      ).catch((error) => {
        throw new AppError(
          'CHANNEL_OAUTH_INCOMPLETE',
          400,
          'Meta did not grant a WhatsApp Business account to this connection. Add whatsapp_business_management and whatsapp_business_messaging to the Embedded Signup configuration, then reconnect.',
          { cause: error instanceof AppError ? error.code : 'META_PERMISSION_MISSING' },
        );
      });
  const wabas: { id: string; name?: string; businessId: string }[] = [];
  wabas.push(...grantedWabaIds.map((id) => ({ id, businessId: '' })));
  for (const business of businesses.data ?? []) {
    const owned = await graphGet<{ data?: { id: string; name?: string }[] }>(
      `/${business.id}/owned_whatsapp_business_accounts?fields=id,name`,
      userToken,
    ).catch(() => ({ data: [] as { id: string; name?: string }[] }));
    wabas.push(...(owned.data ?? []).map((waba) => ({ ...waba, businessId: business.id })));
  }
  const waba = wabas[0];
  if (!waba) {
    throw new AppError(
      'CHANNEL_OAUTH_INCOMPLETE',
      400,
      'No WhatsApp Business account came back from Meta. Finish WhatsApp signup and try again.',
    );
  }

  const numbers = await graphGet<{
    data?: { id: string; display_phone_number?: string; verified_name?: string }[];
  }>(`/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name`, userToken);
  const number = numbers.data?.[0];
  if (!number) {
    throw new AppError(
      'CHANNEL_OAUTH_INCOMPLETE',
      400,
      'That WhatsApp Business account has no phone number yet. Add and verify one in Meta, then connect again.',
    );
  }

  return {
    externalId: number.id,
    displayName: number.verified_name || number.display_phone_number || 'WhatsApp Business',
    credentials: {
      // The user token is the business's own; it is what the adapter sends with.
      accessToken: userToken,
      phoneNumberId: number.id,
      wabaId: waba.id,
      // Signature verification uses the app secret, which is ours, not theirs.
      appSecret: metaApp().appSecret,
    },
    metadata: {
      wabaId: waba.id,
      businessId: waba.businessId || null,
      phoneNumberId: number.id,
      wabaName: waba.name ?? null,
      displayPhoneNumber: number.display_phone_number ?? null,
      tokenExpiresAt,
      connectedVia: 'meta_embedded_signup',
    },
  };
}

/** The Facebook Page authorised for Messenger. Instagram never enters here. */
async function resolvePage(
  userToken: string,
  tokenExpiresAt: string | null,
): Promise<Pick<ResolvedConnection, 'externalId' | 'displayName' | 'credentials' | 'metadata'>> {
  const pages = await graphGet<{
    data?: {
      id: string;
      name?: string;
      access_token?: string;
    }[];
  }>(
    '/me/accounts?fields=id,name,access_token',
    userToken,
  );

  const candidates = pages.data ?? [];
  if (candidates.length === 0) {
    throw new AppError(
      'CHANNEL_OAUTH_INCOMPLETE',
      400,
      'No Facebook Page came back from Meta. Make sure you granted access to the Page you want to connect.',
    );
  }

  const page = candidates[0]!;
  return {
    externalId: page.id,
    displayName: page.name ?? 'Facebook Page',
    credentials: {
      pageAccessToken: page.access_token ?? '',
      pageId: page.id,
      appSecret: metaApp().appSecret,
    },
    metadata: { facebookPageId: page.id, pageName: page.name ?? null, tokenExpiresAt, connectedVia: 'meta_oauth' },
  };
}

/**
 * Subscribe the connected account to message webhooks.
 *
 * Without this Meta accepts the connection and then sends nothing, which is
 * the failure mode that looks exactly like "it is connected but not working".
 */
export async function subscribeWebhooks(connection: ResolvedConnection): Promise<void> {
  const { channelType, credentials } = connection;
  if (channelType === 'WHATSAPP') {
    const res = await fetch(
      `${graph()}/${credentials.wabaId}/subscribed_apps?access_token=${encodeURIComponent(credentials.accessToken ?? '')}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      throw new AppError(
        'CHANNEL_WEBHOOK_SUBSCRIBE_FAILED',
        502,
        'Connected, but Meta would not turn on message delivery. Try reconnecting.',
      );
    }
    return;
  }

  if (channelType === 'INSTAGRAM') {
    if (instagramLoginMode() === 'FACEBOOK_PAGE') {
      const fields = ['messages', 'messaging_seen', 'messaging_postbacks'];
      const res = await fetch(
        `${graph()}/${credentials.pageId}/subscribed_apps?access_token=${encodeURIComponent(credentials.pageAccessToken ?? '')}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscribed_fields: fields.join(',') }) },
      );
      if (!res.ok) throw new AppError('INSTAGRAM_WEBHOOK_SUBSCRIPTION_FAILED', 502, 'Instagram connected through Facebook, but message webhook delivery could not be enabled.');
      return;
    }
    const params = new URLSearchParams({
      subscribed_fields: ['messages', 'messaging_seen', 'messaging_postbacks'].join(','),
      access_token: credentials.accessToken ?? '',
    });
    const res = await fetch(
      `${env.instagram.graphUrl}/${credentials.instagramAccountId}/subscribed_apps?${params.toString()}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      throw new AppError('INSTAGRAM_WEBHOOK_SUBSCRIPTION_FAILED', 502, 'Instagram connected, but message webhook delivery could not be enabled. Reconnect and confirm the messaging permission.');
    }
    return;
  }

  const fields = ['messages', 'message_deliveries', 'message_reads', 'messaging_postbacks'];
  const res = await fetch(
    `${graph()}/${credentials.pageId}/subscribed_apps?access_token=${encodeURIComponent(credentials.pageAccessToken ?? '')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed_fields: fields.join(',') }),
    },
  );
  if (!res.ok) {
    throw new AppError(
      'CHANNEL_WEBHOOK_SUBSCRIBE_FAILED',
      502,
      'Connected, but Meta would not turn on message delivery. Try reconnecting.',
    );
  }
}

/** A per-account webhook secret, used as Meta's verify token. */
export const newWebhookSecret = (): string => randomUUID().replace(/-/g, '');
