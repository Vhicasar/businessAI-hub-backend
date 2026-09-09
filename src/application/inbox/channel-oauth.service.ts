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
    // Embedded Signup returns a WABA the business either has or creates inline.
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'],
    label: 'WhatsApp Business',
  },
  FACEBOOK_MESSENGER: {
    scopes: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'business_management'],
    label: 'Facebook Page',
  },
  INSTAGRAM: {
    // Instagram messaging is granted through the Page the account is linked to.
    scopes: [
      'instagram_basic',
      'instagram_manage_messages',
      'pages_show_list',
      'pages_manage_metadata',
      'business_management',
    ],
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

/** Used by the application-level webhook receiver; never returned to clients. */
export const metaAppSecret = (): string => metaApp().appSecret;

/** Whether a Meta app is configured at all, from either source. */
export function metaConfigured(): boolean {
  const { appId, appSecret } = metaApp();
  return Boolean(appId && appSecret);
}

export function supportsOAuth(channelType: ChannelType): boolean {
  return channelType in OAUTH_CHANNELS && metaConfigured();
}

/** Why OAuth is unavailable, phrased for whoever has to fix it. */
export function oauthUnavailableReason(channelType: ChannelType): string | null {
  if (!(channelType in OAUTH_CHANNELS)) {
    return `${channelType} cannot be connected automatically — it is set up with its own credentials.`;
  }
  if (!metaConfigured()) {
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

  const params = new URLSearchParams({
    client_id: metaApp().appId,
    redirect_uri: callbackUrl(input.channelType),
    state,
    scope: config.scopes.join(','),
    response_type: 'code',
  });
  // WhatsApp uses Embedded Signup, which is the same OAuth dialog driven by a
  // configuration built in the Meta dashboard — it walks the business through
  // creating or picking a WABA and a phone number.
  if (input.channelType === 'WHATSAPP' && env.meta.whatsappConfigId) {
    params.set('config_id', env.meta.whatsappConfigId);
    params.set('override_default_response_type', 'true');
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
async function exchangeCode(code: string, channelType: ChannelType): Promise<{ accessToken: string; expiresAt: string | null }> {
  const params = new URLSearchParams({
    client_id: metaApp().appId,
    client_secret: metaApp().appSecret,
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

/**
 * Finish the flow: verify the state, exchange the code, and find out what the
 * business actually authorised.
 */
export async function completeCallback(input: {
  channelType: ChannelType;
  code: string;
  state: string;
}): Promise<ResolvedConnection> {
  const payload = verifyState(input.state);
  // The state says which channel it was issued for; a state minted for one
  // channel must not complete another.
  if (payload.provider !== `channel:${input.channelType}`) {
    throw new AppError('OAUTH_STATE_INVALID', 400, 'This connection link is for a different channel.');
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
  return { ...base, ...(await resolvePage(token.accessToken, input.channelType, token.expiresAt)) };
}

/** The WABA and phone number the business picked during Embedded Signup. */
async function resolveWhatsApp(
  userToken: string,
  tokenExpiresAt: string | null,
): Promise<Pick<ResolvedConnection, 'externalId' | 'displayName' | 'credentials' | 'metadata'>> {
  const businesses = await graphGet<{ data?: { id: string; name?: string }[] }>(
    '/me/businesses?fields=id,name',
    userToken,
  );
  const wabas: { id: string; name?: string; businessId: string }[] = [];
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
      businessId: waba.businessId,
      phoneNumberId: number.id,
      wabaName: waba.name ?? null,
      displayPhoneNumber: number.display_phone_number ?? null,
      tokenExpiresAt,
      connectedVia: 'meta_embedded_signup',
    },
  };
}

/** The Page (and for Instagram, the account linked to it) that was authorised. */
async function resolvePage(
  userToken: string,
  channelType: ChannelType,
  tokenExpiresAt: string | null,
): Promise<Pick<ResolvedConnection, 'externalId' | 'displayName' | 'credentials' | 'metadata'>> {
  const pages = await graphGet<{
    data?: {
      id: string;
      name?: string;
      access_token?: string;
      instagram_business_account?: { id: string; username?: string };
    }[];
  }>(
    '/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}',
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

  if (channelType === 'INSTAGRAM') {
    const linked = candidates.find((p) => p.instagram_business_account?.id);
    if (!linked?.instagram_business_account) {
      throw new AppError(
        'CHANNEL_OAUTH_INCOMPLETE',
        400,
        'None of your Pages has an Instagram professional account linked. Link one in Meta Business Suite, then connect again.',
      );
    }
    const ig = linked.instagram_business_account;
    return {
      externalId: ig.id,
      displayName: ig.username ? `@${ig.username}` : 'Instagram',
      credentials: {
        // Instagram DMs are sent with the linked Page's token, not a separate one.
        pageAccessToken: linked.access_token ?? '',
        pageId: linked.id,
        instagramAccountId: ig.id,
        appSecret: metaApp().appSecret,
      },
      metadata: {
        facebookPageId: linked.id,
        instagramAccountId: ig.id,
        pageName: linked.name ?? null,
        username: ig.username ?? null,
        tokenExpiresAt,
        connectedVia: 'meta_oauth',
      },
    };
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

  const fields =
    channelType === 'INSTAGRAM'
      ? ['messages', 'messaging_seen', 'messaging_postbacks']
      : ['messages', 'message_deliveries', 'message_reads', 'messaging_postbacks'];
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
