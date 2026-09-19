import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeWebhooks, type ResolvedConnection } from '../../src/application/inbox/channel-oauth.service';
import { connectChannelSchema } from '../../src/application/inbox/channels.service';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';

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
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { is_valid: true, app_id: process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: 'actual-id', username: 'shop' }) }));
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    await expect(adapter.onAccountConnected!({
      id: 'account', organizationId: 'org', externalId: 'expected-id', webhookSecret: null,
      credentials: { accessToken: 'token', appId: process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '', appSecret: 'secret', instagramAccountId: 'expected-id' },
    }, 'https://example.test/api/webhooks/instagram')).rejects.toMatchObject({ code: 'CHANNEL_MISCONFIGURED' });
  });

  it('does not accept a valid Instagram profile token without messaging permission', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { is_valid: true, app_id: process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: 'ig-1', username: 'shop' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ permission: 'instagram_business_basic', status: 'granted' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    await expect(adapter.onAccountConnected!({
      id: 'account', organizationId: 'org', externalId: 'ig-1', webhookSecret: null,
      credentials: { accessToken: 'token', appId: process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '', appSecret: 'secret', instagramAccountId: 'ig-1' },
    }, 'https://example.test/api/webhooks/instagram')).rejects.toMatchObject({ code: 'INSTAGRAM_MESSAGING_PERMISSION_MISSING' });
  });
});
