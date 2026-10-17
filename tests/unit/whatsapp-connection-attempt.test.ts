import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimWhatsAppConnectionAttempt, whatsappEmbeddedSignupConfig } from '../../src/application/inbox/channel-oauth.service';
import { signState } from '../../src/application/integrations/oauth-connection.service';
import { prismaUnscoped } from '../../src/infrastructure/database/prisma';
import { env } from '../../src/shared/config/env';

const signedState = (attemptId: string, organizationId = 'org-1', userId = 'user-1') => signState({
  organizationId, userId, provider: 'channel:WHATSAPP', returnTo: '/settings',
  issuedAt: Date.now(), connectionAttemptId: attemptId,
});

describe('WhatsApp connection attempts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an expiring attempt bound to the initiating tenant and user', async () => {
    const previous = env.meta.whatsappConfigId;
    env.meta.whatsappConfigId = 'config-1';
    const create = vi.spyOn(prismaUnscoped.whatsAppConnectionAttempt, 'create').mockResolvedValue({} as never);
    try {
      const result = await whatsappEmbeddedSignupConfig({ organizationId: 'org-1', userId: 'user-1', returnTo: '/settings' });
      expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
        id: result.connectionAttemptId, organizationId: 'org-1', userId: 'user-1',
        connectionMode: 'WHATSAPP_BUSINESS_APP_COEXISTENCE', expiresAt: expect.any(Date),
      }) });
    } finally {
      env.meta.whatsappConfigId = previous;
    }
  });

  it('rejects a signed state belonging to another tenant before touching the attempt', async () => {
    const update = vi.spyOn(prismaUnscoped.whatsAppConnectionAttempt, 'updateMany');
    await expect(claimWhatsAppConnectionAttempt({
      id: '11111111-1111-4111-8111-111111111111', state: signedState('11111111-1111-4111-8111-111111111111', 'other-org'),
      organizationId: 'org-1', userId: 'user-1', connectionMode: 'STANDARD_CLOUD_API',
    })).rejects.toMatchObject({ code: 'WHATSAPP_CONNECTION_ATTEMPT_INVALID' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an expired durable attempt', async () => {
    vi.spyOn(prismaUnscoped.whatsAppConnectionAttempt, 'updateMany').mockResolvedValue({ count: 0 });
    vi.spyOn(prismaUnscoped.whatsAppConnectionAttempt, 'findUnique').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', userId: 'user-1',
      status: 'PENDING', expiresAt: new Date(Date.now() - 1000), channelAccountId: null,
    } as never);
    await expect(claimWhatsAppConnectionAttempt({
      id: '11111111-1111-4111-8111-111111111111', state: signedState('11111111-1111-4111-8111-111111111111'),
      organizationId: 'org-1', userId: 'user-1', connectionMode: 'STANDARD_CLOUD_API',
    })).rejects.toMatchObject({ code: 'WHATSAPP_CONNECTION_ATTEMPT_EXPIRED' });
  });

  it('handles a completed replay idempotently without exchanging the code again', async () => {
    vi.spyOn(prismaUnscoped.whatsAppConnectionAttempt, 'updateMany').mockResolvedValue({ count: 0 });
    vi.spyOn(prismaUnscoped.whatsAppConnectionAttempt, 'findUnique').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', userId: 'user-1',
      status: 'COMPLETED', expiresAt: new Date(Date.now() + 60_000), channelAccountId: 'channel-1',
    } as never);
    await expect(claimWhatsAppConnectionAttempt({
      id: '11111111-1111-4111-8111-111111111111', state: signedState('11111111-1111-4111-8111-111111111111'),
      organizationId: 'org-1', userId: 'user-1', connectionMode: 'STANDARD_CLOUD_API',
    })).resolves.toEqual({ alreadyCompletedAccountId: 'channel-1' });
  });
});

/*
 * The redirect dialog — the only Embedded Signup flow that completes on a
 * phone, where the JS SDK defers to the native Facebook app and comes back
 * with nothing. It is the same Meta configuration as the desktop popup, so it
 * has to carry the same onboarding and nothing that contradicts the config.
 */
describe('WhatsApp Embedded Signup redirect URL', () => {
  const withConfigId = async (configId: string | undefined) => {
    const previous = process.env.META_WHATSAPP_CONFIG_ID;
    if (configId === undefined) delete process.env.META_WHATSAPP_CONFIG_ID;
    else process.env.META_WHATSAPP_CONFIG_ID = configId;
    vi.resetModules();
    const fresh = await import('../../src/application/inbox/channel-oauth.service');
    const { url } = fresh.authorizationUrl({
      channelType: 'WHATSAPP',
      organizationId: 'org-1',
      userId: 'user-1',
      returnTo: '/settings',
    });
    if (previous === undefined) delete process.env.META_WHATSAPP_CONFIG_ID;
    else process.env.META_WHATSAPP_CONFIG_ID = previous;
    return new URL(url);
  };

  it('drives the configured signup and returns a code to our callback', async () => {
    const url = await withConfigId('config-abc');
    expect(url.origin + url.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$/);
    expect(url.searchParams.get('config_id')).toBe('config-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toContain('/channels/whatsapp/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('offers a phone the same onboarding the desktop popup offers', async () => {
    const url = await withConfigId('config-abc');
    expect(JSON.parse(url.searchParams.get('extras') ?? '{}')).toEqual({
      setup: {}, featureType: 'whatsapp_business_app_onboarding',
    });
  });

  it('lets the configuration decide the permissions, not a scope list', async () => {
    const url = await withConfigId('config-abc');
    expect(url.searchParams.has('scope')).toBe(false);
  });

  it('still asks for scopes where there is no Embedded Signup configuration', async () => {
    const url = await withConfigId(undefined);
    expect(url.searchParams.has('config_id')).toBe(false);
    expect(url.searchParams.get('scope')).toContain('whatsapp_business_messaging');
    // Without granular Embedded Signup targets, the WABA has to be enumerated.
    expect(url.searchParams.get('scope')).toContain('business_management');
  });
});
