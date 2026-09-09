import { describe, expect, it } from 'vitest';
import { extractMetaRoutingIds, stableMetaWebhookPath, verifyMetaChallenge } from '../../src/presentation/http/webhooks.routes';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';

describe('stable Meta webhook architecture', () => {
  it('uses application-level callback paths', () => {
    expect(stableMetaWebhookPath('WHATSAPP')).toBe('/api/webhooks/whatsapp');
    expect(stableMetaWebhookPath('FACEBOOK_MESSENGER')).toBe('/api/webhooks/messenger');
    expect(stableMetaWebhookPath('INSTAGRAM')).toBe('/api/webhooks/instagram');
    expect(stableMetaWebhookPath('EMAIL')).toBeNull();
  });

  it('accepts only the configured Meta subscription challenge', () => {
    const valid = { 'hub.mode': 'subscribe', 'hub.verify_token': 'secure-token', 'hub.challenge': 'challenge' };
    expect(verifyMetaChallenge(valid, 'secure-token')).toBe('challenge');
    expect(verifyMetaChallenge(valid, 'wrong-token')).toBeNull();
    expect(verifyMetaChallenge({ ...valid, 'hub.mode': 'publish' }, 'secure-token')).toBeNull();
  });

  it('extracts WhatsApp WABA and phone-number routing identifiers', () => {
    expect(extractMetaRoutingIds('WHATSAPP', {
      id: 'waba-1', changes: [{ value: { metadata: { phone_number_id: 'phone-1' } } }],
    })).toEqual({ entryId: 'waba-1', phoneNumberId: 'phone-1' });
  });

  it('rejects malformed entries by yielding no routing identifier', () => {
    expect(extractMetaRoutingIds('INSTAGRAM', { changes: [] })).toEqual({ entryId: null, phoneNumberId: null });
  });

  it('normalizes Messenger postbacks with deterministic ids for deduplication', () => {
    const adapter = new MetaMessagingAdapter('FACEBOOK_MESSENGER', 'page');
    const payload = { object: 'page', entry: [{ messaging: [{ sender: { id: 'customer' }, timestamp: 123, postback: { title: 'Start', payload: 'START' } }] }] };
    const first = adapter.parseInbound(payload);
    const second = adapter.parseInbound(payload);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ senderExternalId: 'customer', contentType: 'TEXT', text: 'Start' });
    expect(second[0]?.providerMessageId).toBe(first[0]?.providerMessageId);
  });
});
