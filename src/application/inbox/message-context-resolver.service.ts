import type { ChannelType, Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import type { NormalizedInbound, NormalizedMessageType, ReferencedContent } from './channel-adapter';
import { sharedContentResolver } from './shared-content-resolver.service';

export type ProductMatchMethod = 'external_reference' | 'external_product_id' | 'product_url' | 'sku' | 'exact_name' | 'caption_text' | 'conversation_memory';

export interface ResolvedProductContext {
  productId: string;
  name: string;
  confidence: number;
  matchMethod: ProductMatchMethod;
  variants: Array<{
    id: string; name: string | null; sku: string; options: unknown;
    price: number; compareAtPrice: number | null; currency: string; available: number;
  }>;
}

export interface ResolvedMessageContext {
  messageType: NormalizedMessageType;
  references: ReferencedContent[];
  products: ResolvedProductContext[];
  needsClarification: boolean;
  salesIntent: string;
}

function threshold(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
const AUTO_MATCH = threshold('PRODUCT_MATCH_AUTO_THRESHOLD', 0.9);
const LIKELY_MATCH = threshold('PRODUCT_MATCH_LIKELY_THRESHOLD', 0.7);

export function inferMessageType(inbound: NormalizedInbound): NormalizedMessageType {
  if (inbound.messageType) return inbound.messageType;
  if (inbound.referencedContent?.length && inbound.text) return 'mixed';
  if (inbound.referencedContent?.length) return 'shared_media';
  if (/https?:\/\//i.test(inbound.text ?? '')) return 'link';
  return ({ TEXT: 'text', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', DOCUMENT: 'document' } as Record<string, NormalizedMessageType>)[inbound.contentType] ?? 'unknown';
}

function safeProviderValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeProviderValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(token|secret|password|authorization|cookie)/i.test(key))
      .slice(0, 80)
      .map(([key, item]) => [key, safeProviderValue(item, depth + 1)]));
  }
  return typeof value === 'string' ? value.slice(0, 4000) : value;
}

export function detectSalesIntent(text: string, hasProduct: boolean): string {
  const value = text.toLowerCase();
  if (/\b(buy|take|want|need|order|give me)\b/.test(value)) return 'PURCHASE_INTENT';
  if (/\b(available|stock|have this|in stock)\b/.test(value)) return 'PRODUCT_AVAILABILITY';
  if (/\b(price|how much|cost)\b/.test(value)) return 'PRODUCT_PRICE';
  if (/\b(size|colour|color|variant|black|white|red|blue)\b/.test(value)) return 'PRODUCT_VARIANT';
  if (/\b(deliver|delivery|ship|today|tomorrow)\b/.test(value)) return 'DELIVERY_ENQUIRY';
  if (/\b(compare|difference|both)\b/.test(value)) return 'PRODUCT_COMPARISON';
  return hasProduct ? 'PRODUCT_ENQUIRY' : 'UNKNOWN';
}

const productSelect = {
  id: true, name: true,
  variants: {
    where: { deletedAt: null, isActive: true },
    select: {
      id: true, name: true, sku: true, options: true, price: true, compareAtPrice: true, currency: true,
      stockLevels: { select: { quantity: true, reserved: true } },
    },
  },
} as const;

async function liveProduct(organizationId: string, id: string, confidence: number, matchMethod: ProductMatchMethod): Promise<ResolvedProductContext | null> {
  const product = await prismaUnscoped.product.findFirst({
    where: { id, organizationId, deletedAt: null, status: 'ACTIVE', sellable: true },
    select: productSelect,
  });
  if (!product) return null;
  const resolved = {
    productId: product.id, name: product.name, confidence, matchMethod,
    variants: product.variants.map((variant) => ({
      id: variant.id, name: variant.name, sku: variant.sku, options: variant.options,
      price: Number(variant.price), compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
      currency: variant.currency,
      available: variant.stockLevels.reduce((total, level) => total + Number(level.quantity) - Number(level.reserved), 0),
    })),
  };
  logger.info({ event: 'inventory_checked', organizationId, productId: product.id, variantCount: resolved.variants.length }, 'Live product inventory checked');
  return resolved;
}

async function matchReferences(organizationId: string, references: ReferencedContent[], text: string): Promise<ResolvedProductContext[]> {
  const candidates = new Map<string, { confidence: number; method: ProductMatchMethod }>();
  const externalIds = references.flatMap((ref) => [ref.externalId, ref.externalPostId, ref.externalProductId].filter((v): v is string => Boolean(v)));
  const urls = references.flatMap((ref) => [ref.productUrl, ref.permalink].filter((v): v is string => Boolean(v)));
  if (externalIds.length || urls.length) {
    const mappings = await prismaUnscoped.productExternalReference.findMany({
      where: { organizationId, OR: [
        ...(externalIds.length ? [{ externalId: { in: externalIds } }] : []),
        ...(urls.length ? [{ url: { in: urls } }] : []),
      ] },
      select: { productId: true },
    });
    for (const mapping of mappings) candidates.set(mapping.productId, { confidence: 1, method: 'external_reference' });
  }

  for (const ref of references) {
    if (ref.productId) {
      const explicit = await prismaUnscoped.product.findFirst({ where: { id: ref.productId, organizationId, deletedAt: null }, select: { id: true } });
      if (explicit) candidates.set(explicit.id, { confidence: 1, method: 'external_product_id' });
    }
    const productPath = (ref.productUrl ?? ref.permalink)?.match(/\/products\/([^/?#]+)/i)?.[1];
    if (productPath) {
      const urlProduct = await prismaUnscoped.product.findFirst({ where: { organizationId, deletedAt: null, OR: [{ id: productPath }, { slug: productPath }] }, select: { id: true } });
      if (urlProduct) candidates.set(urlProduct.id, { confidence: 1, method: 'product_url' });
    }
    if (ref.externalProductId) {
      const direct = await prismaUnscoped.product.findFirst({ where: { id: ref.externalProductId, organizationId, deletedAt: null }, select: { id: true } });
      if (direct) candidates.set(direct.id, { confidence: 1, method: 'external_product_id' });
    }
    if (ref.sku) {
      const variant = await prismaUnscoped.productVariant.findFirst({ where: { organizationId, sku: ref.sku, deletedAt: null }, select: { productId: true } });
      if (variant) candidates.set(variant.productId, { confidence: .99, method: 'sku' });
    }
  }

  const searchable = [text, ...references.flatMap((ref) => [ref.caption, ref.text])].filter(Boolean).join(' ').trim();
  if (candidates.size === 0 && searchable) {
    const exact = await prismaUnscoped.product.findFirst({
      where: { organizationId, deletedAt: null, status: 'ACTIVE', name: { equals: searchable, mode: 'insensitive' } }, select: { id: true },
    });
    if (exact) candidates.set(exact.id, { confidence: .96, method: 'exact_name' });
    else {
      const terms = searchable.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu)?.slice(0, 12) ?? [];
      if (terms.length) {
        const possible = await prismaUnscoped.product.findMany({
          where: { organizationId, deletedAt: null, status: 'ACTIVE', OR: terms.map((term) => ({ name: { contains: term, mode: 'insensitive' as const } })) },
          select: { id: true, name: true }, take: 5,
        });
        for (const product of possible) {
          const hits = terms.filter((term) => product.name.toLowerCase().includes(term.toLowerCase())).length;
          const confidence = Math.min(.89, .65 + hits * .08);
          if (confidence >= LIKELY_MATCH) candidates.set(product.id, { confidence, method: 'caption_text' });
        }
      }
    }
  }
  const resolved = await Promise.all([...candidates].map(([id, match]) => liveProduct(organizationId, id, match.confidence, match.method)));
  return resolved.filter((item): item is ResolvedProductContext => Boolean(item)).sort((a, b) => b.confidence - a.confidence);
}

export const messageContextResolver = {
  providerMetadata(inbound: NormalizedInbound): Prisma.InputJsonValue {
    return safeProviderValue({ raw: inbound.raw, metadata: inbound.metadata, caption: inbound.caption, attachments: inbound.attachments, replyTo: inbound.replyTo, referencedContent: inbound.referencedContent }) as Prisma.InputJsonValue;
  },

  async conversationProducts(organizationId: string, conversationId: string): Promise<ResolvedProductContext[]> {
    const conversation = await prismaUnscoped.conversation.findFirst({ where: { id: conversationId, organizationId }, select: { metadata: true } });
    const metadata = (conversation?.metadata && typeof conversation.metadata === 'object' && !Array.isArray(conversation.metadata)) ? conversation.metadata as Record<string, unknown> : {};
    const remembered = Array.isArray(metadata.productContext) ? metadata.productContext as Array<{ productId?: string; confidence?: number; matchMethod?: ProductMatchMethod }> : [];
    const products = await Promise.all(remembered.slice(0, 8).map((item) => item.productId
      ? liveProduct(organizationId, item.productId, item.confidence ?? .95, item.matchMethod ?? 'conversation_memory')
      : null));
    return products.filter((item): item is ResolvedProductContext => Boolean(item));
  },

  async correctProduct(input: { organizationId: string; messageId: string; productId: string; saveMapping: boolean }) {
    const [message, product] = await Promise.all([
      prismaUnscoped.message.findFirst({ where: { id: input.messageId, organizationId: input.organizationId }, select: { id: true, conversationId: true, contextSnapshot: true, conversation: { select: { metadata: true } } } }),
      prismaUnscoped.product.findFirst({ where: { id: input.productId, organizationId: input.organizationId, deletedAt: null }, select: { id: true } }),
    ]);
    if (!message || !product) return null;
    const resolved = await liveProduct(input.organizationId, product.id, 1, 'external_reference');
    if (!resolved) return null;
    const old = (message.contextSnapshot && typeof message.contextSnapshot === 'object' && !Array.isArray(message.contextSnapshot)) ? message.contextSnapshot as Record<string, unknown> : {};
    const references = Array.isArray(old.references) ? old.references as ReferencedContent[] : [];
    const snapshot = { ...old, products: [resolved], needsClarification: false, correctedByUser: true };
    const conversationMetadata = (message.conversation.metadata && typeof message.conversation.metadata === 'object' && !Array.isArray(message.conversation.metadata)) ? message.conversation.metadata as Record<string, unknown> : {};
    await prismaUnscoped.$transaction([
      prismaUnscoped.message.update({ where: { id: message.id }, data: { contextSnapshot: snapshot as unknown as Prisma.InputJsonValue } }),
      prismaUnscoped.conversation.update({ where: { id: message.conversationId }, data: { metadata: { ...conversationMetadata, productContext: [{ productId: resolved.productId, name: resolved.name, confidence: 1, matchMethod: 'external_reference' }] } as Prisma.InputJsonValue } }),
      ...(input.saveMapping ? references.flatMap((reference) => {
        const externalId = reference.externalId ?? reference.externalPostId ?? reference.externalProductId;
        return externalId ? [prismaUnscoped.productExternalReference.upsert({
          where: { organizationId_channel_externalId: { organizationId: input.organizationId, channel: reference.provider, externalId } },
          create: { organizationId: input.organizationId, productId: product.id, channel: reference.provider, externalId, type: reference.type, url: reference.productUrl ?? reference.permalink, catalogId: reference.catalogId },
          update: { productId: product.id, type: reference.type, url: reference.productUrl ?? reference.permalink, catalogId: reference.catalogId },
        })] : [];
      }) : []),
    ]);
    return snapshot;
  },

  async resolve(input: { organizationId: string; conversationId: string; channelType: ChannelType; inbound: NormalizedInbound }): Promise<ResolvedMessageContext> {
    const references = sharedContentResolver.resolve({ ...input, inbound: input.inbound });
    logger.info({ event: 'message_normalized', organizationId: input.organizationId, conversationId: input.conversationId, channelType: input.channelType, messageType: inferMessageType(input.inbound), referenceCount: references.length }, 'Inbound message normalized');
    if (references.length) logger.info({ event: 'reference_detected', organizationId: input.organizationId, conversationId: input.conversationId, referenceTypes: references.map((reference) => reference.type) }, 'Referenced content detected');
    logger.info({ event: 'product_match_attempted', organizationId: input.organizationId, conversationId: input.conversationId }, 'Product context match attempted');
    let products = await matchReferences(input.organizationId, references, input.inbound.text ?? '');
    const conversation = await prismaUnscoped.conversation.findFirst({ where: { id: input.conversationId, organizationId: input.organizationId }, select: { metadata: true } });
    const previous = (conversation?.metadata && typeof conversation.metadata === 'object' && !Array.isArray(conversation.metadata)) ? conversation.metadata as Record<string, unknown> : {};
    const remembered = Array.isArray(previous.productContext) ? previous.productContext as Array<{ productId?: string; confidence?: number; matchMethod?: ProductMatchMethod }> : [];
    const restored = await Promise.all(remembered.slice(0, 8).map((item) => item.productId ? liveProduct(input.organizationId, item.productId, item.confidence ?? .95, item.matchMethod ?? 'conversation_memory') : null));
    const rememberedProducts = restored.filter((item): item is ResolvedProductContext => Boolean(item));
    if (products.length === 0 && references.length === 0) products = rememberedProducts;
    else if (products.length > 0) {
      const newIds = new Set(products.map((product) => product.productId));
      products = [...products, ...rememberedProducts.filter((product) => !newIds.has(product.productId))].slice(0, 8);
    }
    const context: ResolvedMessageContext = {
      messageType: inferMessageType(input.inbound), references, products,
      needsClarification: references.length > 0 && (products.length === 0 || products[0]!.confidence < AUTO_MATCH),
      salesIntent: detectSalesIntent(input.inbound.text ?? '', products.length > 0),
    };
    await prismaUnscoped.conversation.update({
      where: { id: input.conversationId },
      data: { metadata: { ...previous, productContext: products.map(({ productId, name, confidence, matchMethod }) => ({ productId, name, confidence, matchMethod })), salesIntent: context.salesIntent } as Prisma.InputJsonValue },
    });
    logger.info({ event: products.length ? 'product_matched' : 'product_match_failed', organizationId: input.organizationId, conversationId: input.conversationId, matchCount: products.length, topConfidence: products[0]?.confidence ?? null, matchMethod: products[0]?.matchMethod ?? null }, 'Message product context resolved');
    if (references.length && products.length) logger.info({ event: 'reference_resolved', organizationId: input.organizationId, conversationId: input.conversationId, productMatchConfidence: products[0]!.confidence }, 'Referenced content resolved');
    return context;
  },
};
