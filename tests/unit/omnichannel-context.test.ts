import { describe, expect, it } from 'vitest';
import { inferMessageType, detectSalesIntent, messageContextResolver } from '../../src/application/inbox/message-context-resolver.service';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';
import { WhatsAppAdapter } from '../../src/infrastructure/channels/whatsapp.adapter';

describe('omnichannel message normalization', () => {
  it('preserves a shared Instagram reel as referenced content instead of a document placeholder', () => {
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    const messages = adapter.parseInbound({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'customer' }, timestamp: 1, message: { mid: 'm1', attachments: [{ type: 'share', payload: { url: 'https://instagram.com/reel/ABC', title: 'New Air Max arrivals', external_id: 'ABC' } }] } }] }] });
    expect(messages[0]).toMatchObject({ contentType: 'TEXT', messageType: 'reel_share', referencedContent: [{ type: 'reel', externalId: 'ABC', permalink: 'https://instagram.com/reel/ABC', caption: 'New Air Max arrivals' }] });
    expect(messages[0]?.media).toBeUndefined();
    expect(messages[0]?.mediaUrl).toBeUndefined();
    expect(messages[0]?.attachments).toBeUndefined();
  });

  it('preserves customer text alongside a shared Instagram reel', () => {
    const adapter = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    const [message] = adapter.parseInbound({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'customer' }, message: { mid: 'mixed', text: 'Do you have this in black?', attachments: [{ type: 'share', payload: { url: 'https://instagram.com/reel/MIXED', title: 'Black trainers' } }] } }] }] });
    expect(message).toMatchObject({ text: 'Do you have this in black?', messageType: 'reel_share', referencedContent: [{ caption: 'Black trainers' }] });
    expect(message?.media).toBeUndefined();
  });

  it('normalizes WhatsApp quoted catalog context and catalog orders', () => {
    const adapter = new WhatsAppAdapter();
    const messages = adapter.parseInbound({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '234', id: 'm2', type: 'text', text: { body: 'How much?' }, context: { id: 'quoted', referred_product: { catalog_id: 'cat', product_retailer_id: 'SKU-1' } } }, { from: '234', id: 'm3', type: 'order', order: { catalog_id: 'cat', product_items: [{ product_retailer_id: 'SKU-2', quantity: '2' }] } }] } }] }] });
    expect(messages[0]).toMatchObject({ messageType: 'reply', replyTo: { externalMessageId: 'quoted' }, referencedContent: [{ sku: 'SKU-1' }] });
    expect(messages[1]).toMatchObject({ messageType: 'catalog_item', referencedContent: [{ sku: 'SKU-2' }] });
  });

  it('classifies mixed media and sales intents without inventing products', () => {
    expect(inferMessageType({ providerMessageId: '1', senderExternalId: 'x', contentType: 'IMAGE', text: 'This one', referencedContent: [{ provider: 'webchat', type: 'product' }] })).toBe('mixed');
    expect(detectSalesIntent('Do you have this in stock?', true)).toBe('PRODUCT_AVAILABILITY');
    expect(detectSalesIntent('Give me 2', true)).toBe('PURCHASE_INTENT');
    expect(detectSalesIntent('Hello', false)).toBe('UNKNOWN');
  });

  it('redacts credential-like keys from retained provider metadata', () => {
    const metadata = messageContextResolver.providerMetadata({ providerMessageId: '1', senderExternalId: 'x', contentType: 'TEXT', raw: { access_token: 'secret', caption: 'shoe' } }) as Record<string, unknown>;
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).toContain('shoe');
  });
});
