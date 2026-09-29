import { describe, expect, it } from 'vitest';
import { sharedContentResolver, safeExternalUrl } from '../../src/application/inbox/shared-content-resolver.service';
import { isHtmlResponseMimeType } from '../../src/application/inbox/inbox-media.service';

const resolve = (inbound: Parameters<typeof sharedContentResolver.resolve>[0]['inbound']) =>
  sharedContentResolver.resolve({ organizationId: 'org', channelType: 'SMS', conversationId: 'conversation', inbound });

describe('shared content resolution', () => {
  it('creates safe generic and product link previews without fetching HTML', () => {
    const references = resolve({
      providerMessageId: 'm1', senderExternalId: 'customer', contentType: 'TEXT',
      text: 'Compare https://shop.example.com/products/shoe and https://example.com/news',
    });
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({ type: 'product', siteName: 'shop.example.com', resolved: false });
    expect(references[1]).toMatchObject({ type: 'link', siteName: 'example.com', resolved: false });
  });

  it('rejects executable URL schemes', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(resolve({
      providerMessageId: 'm2', senderExternalId: 'customer', contentType: 'TEXT', text: 'unsafe',
      referencedContent: [{ provider: 'unknown', type: 'link', permalink: 'javascript:alert(1)' }],
    })).toEqual([]);
  });

  it('recognizes HTML responses as failed media rather than uploadable files', () => {
    expect(isHtmlResponseMimeType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlResponseMimeType('application/xhtml+xml')).toBe(true);
    expect(isHtmlResponseMimeType('video/mp4')).toBe(false);
  });
});
