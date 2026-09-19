import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeWebhooks, type ResolvedConnection } from '../../src/application/inbox/channel-oauth.service';
import { connectChannelSchema } from '../../src/application/inbox/channels.service';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';
import { validateMetaTokenOwnership } from '../../src/infrastructure/channels/whatsapp.adapter';

function connection(channelType: ResolvedConnection['channelType'], credentials: Record<string, string>): ResolvedConnection {
  return {
    organizationId: 'org-1', userId: 'user-1', returnTo: '', channelType,
    externalId: 'external-1', displayName: 'Test', credentials, metadata: {},
  };
}

describe('Meta inbound readiness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires a WABA id for manual WhatsApp because subscriptions are WABA-scoped', () => {
    const parsed = connectChannelSchema.safeParse({
      channelType: 'WHATSAPP', name: 'Support', purpose: 'SUPPORT', autoReply: false,
      credentials: { accessToken: 'token', phoneNumberId: 'phone', appSecret: 'secret' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.at(-1) === 'wabaId')).toBe(true);
  });

  it('requires the owning Meta app credentials for manual Instagram', () => {
    const parsed = connectChannelSchema.safeParse({
      channelType: 'INSTAGRAM', name: 'Instagram', purpose: 'SUPPORT', autoReply: false,
      credentials: { accessToken: 'token', instagramAccountId: 'ig-1' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.at(-1))).toEqual(expect.arrayContaining(['appId', 'appSecret']));
    }
  });

  it.each([
    ['WHATSAPP', { accessToken: 'token', wabaId: 'waba', phoneNumberId: 'phone', appSecret: 'secret' }],
    ['FACEBOOK_MESSENGER', { pageAccessToken: 'token', pageId: 'page', appSecret: 'secret' }],
  ])('requires a Meta App ID for manual %s', (channelType, credentials) => {
    const parsed = connectChannelSchema.safeParse({ channelType, name: 'Test', purpose: 'SUPPORT', autoReply: false, credentials });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.at(-1) === 'appId')).toBe(true);
  });

  it('validates a BYO token against the customer supplied app rather than Vhicasar app', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { is_valid: true, app_id: 'customer-app', scopes: ['pages_messaging', 'pages_manage_metadata'] } }),
    }));
    await expect(validateMetaTokenOwnership({
      appId: 'customer-app', appSecret: 'customer-secret', accessToken: 'customer-token',
      label: 'Facebook Page', requiredScopes: ['pages_messaging', 'pages_manage_metadata'],
    })).resolves.toBe('VERIFIED');
  });

  it('rejects a token issued by a different app with an actionable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ data: { is_valid: true, app_id: 'different-app' } }),
    }));
    await expect(validateMetaTokenOwnership({
      appId: 'customer-app', appSecret: 'customer-secret', accessToken: 'token', label: 'Instagram',
    })).rejects.toMatchObject({ code: 'TOKEN_APP_MISMATCH' });
  });

  it('distinguishes invalid app credentials from a proven token/app mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: { message: 'Invalid appsecret_proof' } }),
    }));
    await expect(validateMetaTokenOwnership({
      appId: 'customer-app', appSecret: 'wrong-secret', accessToken: 'token', label: 'Instagram',
    })).rejects.toMatchObject({ code: 'APP_CREDENTIALS_INVALID' });
  });

  it('returns UNKNOWN rather than inventing a mismatch when Meta omits issuing app identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ data: { is_valid: true } }),
    }));
    await expect(validateMetaTokenOwnership({
      appId: 'customer-app', appSecret: 'secret', accessToken: 'token', label: 'Instagram',
    })).resolves.toBe('UNKNOWN');
  });

  it('subscribes WhatsApp at the WABA subscribed_apps endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'app' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await subscribeWebhooks(connection('WHATSAPP', { accessToken: 'token', wabaId: 'waba-7' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/waba-7/subscribed_apps');
  });

  it('uses direct Instagram subscribed_apps when credentials have no Page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'app' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await subscribeWebhooks(connection('INSTAGRAM', { accessToken: 'token', instagramAccountId: 'ig-9' }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/ig-9/subscribed_apps');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('messages%2Cmessaging_seen%2Cmessaging_postbacks');
  });

  it('keeps Page-linked Instagram subscriptions working independently of the current login preference', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'app' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    await subscribeWebhooks(connection('INSTAGRAM', { pageAccessToken: 'page-token', pageId: 'page-4', instagramAccountId: 'ig-9' }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/page-4/subscribed_apps');
  });

  it('rejects a manual Instagram account id that does not belong to its token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: 'actual-id', username: 'shop', account_type: 'BUSINESS' }) });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    await expect(adapter.onAccountConnected!({
      id: 'account', organizationId: 'org', externalId: 'expected-id', webhookSecret: null,
      credentials: { instagramApiModel: 'INSTAGRAM_LOGIN', accessToken: 'token', appId: 'customer-app', appSecret: 'secret', instagramAccountId: 'expected-id' },
    }, 'https://example.test/api/webhooks/instagram')).rejects.toMatchObject({ code: 'INSTAGRAM_ACCOUNT_MISMATCH' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('graph.instagram.com');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('debug_token');
  });

  it('does not accept a valid Instagram profile token without messaging permission', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: 'ig-1', username: 'shop', account_type: 'BUSINESS' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ permission: 'instagram_business_basic', status: 'granted' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    await expect(adapter.onAccountConnected!({
      id: 'account', organizationId: 'org', externalId: 'ig-1', webhookSecret: null,
      credentials: { instagramApiModel: 'INSTAGRAM_LOGIN', accessToken: 'token', appId: 'customer-app', appSecret: 'secret', instagramAccountId: 'ig-1' },
    }, 'https://example.test/api/webhooks/instagram')).rejects.toMatchObject({ code: 'MESSAGING_PERMISSION_MISSING' });
  });

  it('validates direct Instagram Login without running Facebook debug_token app matching', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: 'ig-1', username: 'shop', account_type: 'BUSINESS' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [
        { permission: 'instagram_business_basic', status: 'granted' },
        { permission: 'instagram_business_manage_messages', status: 'granted' },
      ] }) });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    await expect(adapter.onAccountConnected!({
      id: 'account', organizationId: 'org', externalId: 'ig-1', webhookSecret: null,
      credentials: { instagramApiModel: 'INSTAGRAM_LOGIN', accessToken: 'token', appId: 'any-customer-app', appSecret: 'secret', instagramAccountId: 'ig-1' },
    }, 'https://example.test/api/webhooks/instagram')).resolves.toContain('Credentials validated');
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('debug_token'))).toBe(false);
  });
});
