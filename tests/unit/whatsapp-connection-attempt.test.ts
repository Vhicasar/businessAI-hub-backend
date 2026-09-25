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
