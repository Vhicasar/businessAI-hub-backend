import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizationUrl, completeCallback, subscribeWebhooks } from '../../src/application/inbox/channel-oauth.service';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';

const start = () => authorizationUrl({
  channelType: 'INSTAGRAM',
  organizationId: 'org-instagram',
  userId: 'user-1',
  returnTo: '/settings/integrations',
});

afterEach(() => vi.restoreAllMocks());

describe('direct Instagram Login', () => {
  it('uses Instagram Login, its exact callback and only Instagram business scopes', () => {
    const parsed = new URL(start().url);
    expect(parsed.hostname).toBe('www.instagram.com');
    expect(parsed.pathname).toBe('/oauth/authorize');
    expect(parsed.searchParams.get('redirect_uri')).toMatch(/\/api\/v1\/channels\/instagram\/callback$/);
    expect(parsed.searchParams.get('scope')?.split(',')).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_messages',
    ]);
    expect(parsed.search).not.toContain('pages_');
    expect(parsed.search).not.toContain('business_management');
  });

  it('exchanges the code and resolves a professional account without Facebook Page discovery', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'short-token',
        permissions: ['instagram_business_basic', 'instagram_business_manage_messages'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'long-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 'ig-123', username: 'shop', account_type: 'BUSINESS' }), { status: 200 }));

    const resolved = await completeCallback({ channelType: 'INSTAGRAM', code: 'code', state: start().state });
    expect(resolved.externalId).toBe('ig-123');
    expect(resolved.credentials).toMatchObject({ accessToken: 'long-token', instagramAccountId: 'ig-123' });
    expect(resolved.credentials).not.toHaveProperty('pageAccessToken');
    expect(fetchMock.mock.calls.map(([url]) => String(url)).join('\n')).not.toContain('/me/accounts');
  });

  it('rejects incomplete permissions and ineligible accounts with structured errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: 'short-token', permissions: ['instagram_business_basic'],
    }), { status: 200 }));
    await expect(completeCallback({ channelType: 'INSTAGRAM', code: 'code', state: start().state }))
      .rejects.toMatchObject({ code: 'INSTAGRAM_PERMISSION_MISSING' });
  });

  it('rejects a personal Instagram account after direct profile retrieval', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'long-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 'ig-personal', username: 'person', account_type: 'PERSONAL' }), { status: 200 }));
    await expect(completeCallback({ channelType: 'INSTAGRAM', code: 'code', state: start().state }))
      .rejects.toMatchObject({ code: 'INSTAGRAM_ACCOUNT_NOT_ELIGIBLE' });
  });

  it('subscribes and sends using the direct Instagram account and token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message_id: 'mid-1' }), { status: 200 }));
    const connection = {
      organizationId: 'org', userId: 'user', returnTo: '/', channelType: 'INSTAGRAM' as const,
      externalId: 'ig-123', displayName: '@shop',
      credentials: { accessToken: 'ig-token', instagramAccountId: 'ig-123', appSecret: 'secret' }, metadata: {},
    };
    await subscribeWebhooks(connection);
    const result = await new MetaMessagingAdapter('INSTAGRAM', 'instagram').sendMessage(
      { recipientExternalId: 'customer-1', text: 'hello' },
      { id: 'a', organizationId: 'org', externalId: 'ig-123', webhookSecret: null, credentials: connection.credentials },
    );
    expect(result.providerMessageId).toBe('mid-1');
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.every((url) => url.startsWith('https://graph.instagram.com/') && url.includes('/ig-123/'))).toBe(true);
    expect(urls.join('\n')).not.toContain('graph.facebook.com');
  });

  it('rejects tampered state', async () => {
    await expect(completeCallback({ channelType: 'INSTAGRAM', code: 'code', state: `${start().state}x` }))
      .rejects.toMatchObject({ code: 'INSTAGRAM_STATE_MISMATCH' });
  });
});
