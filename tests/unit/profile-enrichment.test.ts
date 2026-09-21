import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter, NormalizedInbound } from '../../src/application/inbox/channel-adapter';

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('../../src/infrastructure/database/prisma', () => ({
  prismaUnscoped: { customerIdentity: { findFirst } },
}));

import { enrichInboundProfiles } from '../../src/application/inbox/profile-enrichment.service';

const message = (id = 'm1'): NormalizedInbound => ({
  providerMessageId: id, senderExternalId: 'sender-1', contentType: 'TEXT', text: `text-${id}`,
});

const account = { id: 'account-1', organizationId: 'org-1', externalId: 'provider-account', credentials: {}, webhookSecret: null };

describe('profile enrichment orchestration', () => {
  beforeEach(() => findFirst.mockReset());

  it('does not repeat a fresh successful provider lookup', async () => {
    findFirst.mockResolvedValue({
      displayName: 'Ada', profileUrl: 'https://example.test/a.jpg',
      customer: { customFields: { channelProfiles: { INSTAGRAM: {
        firstName: 'Ada', username: 'ada', displayName: 'Ada', profileUrl: 'https://example.test/a.jpg',
        enrichment: { status: 'SUCCESS', attemptedAt: new Date().toISOString() },
      } } } },
    });
    const enrichInbound = vi.fn();
    const adapter = { channelType: 'INSTAGRAM', enrichInbound } as unknown as ChannelAdapter;
    const [result] = await enrichInboundProfiles(adapter, account, [message()]);
    expect(enrichInbound).not.toHaveBeenCalled();
    expect(result?.senderProfile).toMatchObject({ firstName: 'Ada', username: 'ada' });
    expect(result?.profileEnrichment?.reason).toBe('PROFILE_CACHED');
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) }));
  });

  it('looks up one sender once per webhook batch and preserves each message', async () => {
    findFirst.mockResolvedValue(null);
    const enrichInbound = vi.fn(async (inbound: NormalizedInbound) => ({
      ...inbound, senderDisplayName: 'Ada', senderProfile: { username: 'ada' },
    }));
    const adapter = { channelType: 'INSTAGRAM', enrichInbound } as unknown as ChannelAdapter;
    const results = await enrichInboundProfiles(adapter, account, [message('m1'), message('m2')]);
    expect(enrichInbound).toHaveBeenCalledTimes(1);
    expect(results.map((item) => [item.providerMessageId, item.text])).toEqual([['m1', 'text-m1'], ['m2', 'text-m2']]);
  });

  it('converts an adapter exception into a non-fatal diagnostic', async () => {
    findFirst.mockResolvedValue(null);
    const adapter = {
      channelType: 'FACEBOOK_MESSENGER',
      enrichInbound: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    } as unknown as ChannelAdapter;
    const [result] = await enrichInboundProfiles(adapter, account, [message()]);
    expect(result?.text).toBe('text-m1');
    expect(result?.profileEnrichment).toMatchObject({ status: 'FAILED', reason: 'PROFILE_LOOKUP_FAILED' });
  });
});
