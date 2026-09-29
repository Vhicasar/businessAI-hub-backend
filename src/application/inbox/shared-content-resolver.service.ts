import { logger } from '../../shared/logger';
import type { NormalizedInbound, ReferencedContent } from './channel-adapter';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/**
 * Parse a link without ever fetching it. Keeping resolution local gives every
 * channel a useful fallback preview without introducing an SSRF surface.
 */
export function safeExternalUrl(value: string | null | undefined): URL | null {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function typeFor(url: URL, explicit?: string): string {
  if (explicit && explicit !== 'unknown' && explicit !== 'link') return explicit;
  if (/instagram\.com$/i.test(url.hostname) || /facebook\.com$/i.test(url.hostname)) {
    if (/\/reel\//i.test(url.pathname)) return 'reel';
    if (/\/stories\//i.test(url.pathname)) return 'story';
    return 'social_post';
  }
  if (/\/products?\//i.test(url.pathname)) return 'product';
  return explicit === 'link' ? 'link' : 'webpage';
}

function providerFor(url: URL, explicit?: string): string {
  if (explicit) return explicit;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('facebook.com') || host === 'fb.watch') return 'facebook';
  return host;
}

function normalize(reference: ReferencedContent): ReferencedContent | null {
  const candidate = reference.url ?? reference.permalink ?? reference.productUrl;
  const url = safeExternalUrl(candidate);
  if (!url) return candidate ? null : { ...reference, resolved: Boolean(reference.externalId) };
  const canonical = url.toString();
  return {
    ...reference,
    type: typeFor(url, reference.type),
    provider: providerFor(url, reference.provider),
    url: canonical,
    permalink: canonical,
    siteName: reference.siteName ?? url.hostname.replace(/^www\./, ''),
    title: reference.title ?? reference.caption ?? reference.text,
    resolved: reference.resolved ?? Boolean(reference.title || reference.caption || reference.text || reference.externalId),
  };
}

export const sharedContentResolver = {
  resolve(input: { organizationId: string; channelType: string; conversationId: string; inbound: NormalizedInbound }): ReferencedContent[] {
    const explicit = input.inbound.referencedContent ?? [];
    const detected = (input.inbound.text?.match(URL_PATTERN) ?? []).map((url) => ({
      provider: '', type: 'link', url, permalink: url, resolved: false,
    } satisfies ReferencedContent));
    const unique = new Map<string, ReferencedContent>();
    for (const reference of [...explicit, ...detected]) {
      const normalized = normalize(reference);
      if (!normalized) {
        logger.warn({ event: 'referenced_content_unresolved', organizationId: input.organizationId, channelType: input.channelType, conversationId: input.conversationId, reason: 'unsafe_or_invalid_url' }, 'Unsafe shared-content URL ignored');
        continue;
      }
      const key = normalized.url ?? normalized.externalId ?? `${normalized.provider}:${normalized.type}:${unique.size}`;
      if (!unique.has(key)) unique.set(key, normalized);
    }
    const references = [...unique.values()];
    if (references.length) {
      logger.info({ event: 'shared_content_received', organizationId: input.organizationId, channelType: input.channelType, conversationId: input.conversationId, count: references.length, types: references.map((item) => item.type) }, 'Shared content normalized');
      for (const reference of references) {
        if (reference.url) logger.info({ event: 'link_detected', organizationId: input.organizationId, channelType: input.channelType, conversationId: input.conversationId, referenceType: reference.type, provider: reference.provider }, 'Safe external link detected');
        logger.info({ event: reference.url ? 'link_preview_created' : 'link_preview_failed', organizationId: input.organizationId, channelType: input.channelType, conversationId: input.conversationId, referenceType: reference.type, provider: reference.provider, reason: reference.url ? undefined : 'no_safe_url' }, 'Shared-content preview decision recorded');
        logger.info({ event: reference.resolved ? 'referenced_content_resolved' : 'referenced_content_unresolved', organizationId: input.organizationId, channelType: input.channelType, conversationId: input.conversationId, referenceType: reference.type, provider: reference.provider }, 'Shared-content preview classified');
      }
    }
    return references;
  },
};
