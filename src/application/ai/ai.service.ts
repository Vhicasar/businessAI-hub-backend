import { AppError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { resolveAi, resolveAiOptional } from './org-ai.service';
import { extractJson, type AiMessage } from './ai-provider';
import { aiCredits } from '../billing/ai-credits';
import { kbService } from '../support/kb.service';
import { knowledgeService } from '../knowledge/knowledge.service';
import { ordersService } from '../orders/orders.service';
import { appointmentsService } from '../appointments/appointments.service';
import { paymentLinksService } from '../payments/payment-links.service';
import { supportService } from '../support/support.service';
import { notifyService } from '../notifications/notify.service';
import { currentOrgId, resolveEntitlements } from '../billing/entitlements';
import { env } from '../../shared/config/env';
import { filesService } from '../files/files.service';

/** Clamp a model-provided priority to the ticket priority enum. */
function normalizePriority(p?: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' {
  const up = (p ?? '').toUpperCase();
  return up === 'LOW' || up === 'HIGH' || up === 'URGENT' ? up : 'MEDIUM';
}

async function ticketContext(ticketId: string) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: {
      subject: true, description: true, priority: true, status: true,
      customer: { select: { firstName: true, lastName: true } },
    },
  });
  if (!ticket) throw new NotFoundError('Ticket');
  const comments = await prisma.ticketComment.findMany({
    where: { ticketId },
    orderBy: { createdAt: 'asc' },
    select: { authorType: true, body: true, isInternal: true },
  });
  const lines = [
    `Subject: ${ticket.subject}`,
    ticket.description ? `Description: ${ticket.description}` : '',
    ...comments.map((c) => `${c.authorType}${c.isInternal ? ' (internal note)' : ''}: ${c.body}`),
  ].filter(Boolean);
  return { ticket, transcript: lines.join('\n') };
}

async function conversationTranscript(conversationId: string, limit = 50) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
    include: {
      customer: {
        select: {
          id: true, firstName: true, lastName: true, lifetimeValue: true,
          totalOrders: true, aiSummary: true, email: true, phone: true, customFields: true,
        },
      },
      channelAccount: { select: { channelType: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { direction: true, authorType: true, body: true, contentType: true, createdAt: true },
      },
    },
  });
  if (!conversation) throw new NotFoundError('Conversation');

  const lines = [...conversation.messages].reverse().map((m) => {
    const who = m.direction === 'INBOUND' ? 'Customer' : m.authorType === 'BOT' ? 'Bot' : 'Agent';
    return `${who}: ${m.body ?? `[${m.contentType.toLowerCase()}]`}`;
  });
  return { conversation, transcript: lines.join('\n') };
}

type CrmEntityType = 'LEAD' | 'DEAL' | 'CUSTOMER';

/** Engagement signals from the unified timeline — the CRM context AI reasons over. */
async function entityEngagement(entityType: CrmEntityType, entityId: string) {
  const activities = await prisma.activity.findMany({
    where: { entityType, entityId },
    orderBy: { occurredAt: 'desc' },
    take: 40,
    select: { type: true, title: true, occurredAt: true },
  });
  const counts: Record<string, number> = {};
  for (const a of activities) counts[a.type] = (counts[a.type] ?? 0) + 1;
  const lastAt = activities[0]?.occurredAt ?? null;
  return {
    totalInteractions: activities.length,
    byType: counts,
    daysSinceLastActivity: lastAt ? Math.floor((Date.now() - lastAt.getTime()) / 86_400_000) : null,
    recent: activities.slice(0, 8).map((a) => a.title),
  };
}

const variantSelect = {
  where: { deletedAt: null, isActive: true },
  orderBy: { isDefault: 'desc' as const },
  take: 1,
  select: { id: true, price: true, currency: true },
};

/** Active products relevant to the customer's message (for chat suggestions). */
async function productContext(query: string) {
  const terms = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 10);
  const base = { deletedAt: null, status: 'ACTIVE' as const };
  const select = {
    id: true,
    name: true,
    description: true,
    variants: variantSelect,
    images: { orderBy: { position: 'asc' as const }, take: 3, select: { fileId: true } },
  };
  let products = await prisma.product.findMany({
    where: terms.length ? {
      ...base,
      OR: terms.flatMap((t) => [
        { name: { contains: t, mode: 'insensitive' as const } },
        { description: { contains: t, mode: 'insensitive' as const } },
      ]),
    } : base,
    take: 8,
    orderBy: { createdAt: 'desc' },
    select,
  });
  // No name match → offer a few active products as general suggestions.
  if (products.length === 0) {
    products = await prisma.product.findMany({ where: base, take: 6, orderBy: { createdAt: 'desc' }, select });
  }
  return products.filter((p) => p.variants.length > 0);
}

/** Available properties relevant to a customer's natural-language request. */
async function propertyContext(query: string) {
  const terms = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 12);
  const base = { deletedAt: null, status: 'AVAILABLE' as const };
  const select = {
    id: true, reference: true, title: true, description: true, type: true,
    purpose: true, price: true, rentAmount: true, rentPeriod: true, currency: true,
    bedrooms: true, bathrooms: true, city: true, state: true, amenities: true,
    customFields: true,
    media: {
      where: { kind: 'IMAGE' },
      orderBy: { position: 'asc' as const },
      take: 3,
      select: { fileId: true },
    },
  };
  let properties = await prisma.property.findMany({
    where: terms.length ? {
      ...base,
      OR: terms.flatMap((term) => [
        { title: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
        { city: { contains: term, mode: 'insensitive' as const } },
        { state: { contains: term, mode: 'insensitive' as const } },
      ]),
    } : base,
    take: 8,
    orderBy: { createdAt: 'desc' },
    select,
  });
  if (properties.length === 0) {
    properties = await prisma.property.findMany({ where: base, take: 6, orderBy: { createdAt: 'desc' }, select });
  }
  return properties;
}

function propertyStayRates(property: { customFields: unknown }): { daily: number; weekly: number } {
  const custom = (property.customFields as Record<string, unknown> | null) ?? {};
  // Long-term rent must never be mistaken for an Airbnb nightly charge.
  // Short-stay properties opt in explicitly through customFields.
  const dailyValue = Number(custom.dailyRate ?? custom.nightlyRate ?? 0);
  const weeklyValue = Number(custom.weeklyRate ?? 0);
  return {
    daily: Number.isFinite(dailyValue) && dailyValue > 0 ? dailyValue : 0,
    weekly: Number.isFinite(weeklyValue) && weeklyValue > 0 ? weeklyValue : 0,
  };
}

function calculateStayPrice(rates: { daily: number; weekly: number }, durationMin: number) {
  const days = Math.max(1, Math.ceil(durationMin / (24 * 60)));
  if (!rates.daily && !rates.weekly) return { days, weeks: 0, remainderDays: days, total: 0 };
  const effectiveDaily = rates.daily || rates.weekly / 7;
  if (!rates.weekly || days < 7) return { days, weeks: 0, remainderDays: days, total: effectiveDaily * days };
  const weeks = Math.floor(days / 7);
  const remainderDays = days % 7;
  return { days, weeks, remainderDays, total: rates.weekly * weeks + effectiveDaily * remainderDays };
}

async function createStayBooking(
  organizationId: string,
  customerId: string,
  input: { propertyId?: string; checkIn?: string; checkOut?: string; notes?: string },
) {
  const propertyId = input.propertyId?.trim();
  if (!propertyId) throw new Error('no property was selected');
  const checkIn = new Date(input.checkIn ?? '');
  const checkOut = new Date(input.checkOut ?? '');
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()) || checkOut <= checkIn) {
    throw new Error('valid check-in and check-out dates are required');
  }
  if (checkIn.getTime() < Date.now() - 60_000) throw new Error('the check-in time has passed');
  const durationMin = Math.ceil((checkOut.getTime() - checkIn.getTime()) / 60_000);
  if (durationMin > 90 * 24 * 60) throw new Error('online stays are limited to 90 days');

  const property = await prisma.property.findFirst({
    where: { id: propertyId, status: 'AVAILABLE', deletedAt: null },
    select: { id: true, title: true, currency: true, rentAmount: true, customFields: true },
  });
  if (!property) throw new Error('that property is not available');
  const rates = propertyStayRates(property);
  if (!rates.daily && !rates.weekly) throw new Error('that property has no daily or weekly stay rate configured');

  const possibleClashes = await prisma.propertyBooking.findMany({
    where: {
      propertyId,
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      scheduledAt: { lt: checkOut },
    },
    select: { id: true, status: true, scheduledAt: true, durationMin: true },
  });
  const requestedIds = possibleClashes.filter((b) => b.status === 'REQUESTED').map((b) => b.id);
  const activeHolds = requestedIds.length
    ? await prisma.paymentLink.findMany({
        where: {
          resourceType: 'BOOKING', resourceId: { in: requestedIds },
          status: { in: ['PENDING', 'PARTIALLY_PAID'] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { resourceId: true },
      })
    : [];
  const activeHoldIds = new Set(activeHolds.map((link) => link.resourceId).filter(Boolean));
  const staleIds = possibleClashes
    .filter((b) => b.status === 'REQUESTED' && !activeHoldIds.has(b.id))
    .map((b) => b.id);
  if (staleIds.length) {
    await prisma.propertyBooking.updateMany({
      where: { id: { in: staleIds }, status: 'REQUESTED' },
      data: { status: 'CANCELLED' },
    });
  }
  const clash = possibleClashes.some((booking) => {
    if (booking.status === 'REQUESTED' && !activeHoldIds.has(booking.id)) return false;
    const end = booking.scheduledAt.getTime() + booking.durationMin * 60_000;
    return end > checkIn.getTime();
  });
  if (clash) throw new Error('those dates are no longer available');

  const recent = await prisma.propertyBooking.findFirst({
    where: {
      propertyId, customerId, kind: 'STAY', scheduledAt: checkIn,
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      createdAt: { gte: new Date(Date.now() - 10 * 60_000) },
    },
    select: { id: true },
  });
  let bookingId = recent?.id;
  if (!bookingId) {
    const booking = await prisma.propertyBooking.create({
      data: {
        organizationId, propertyId, customerId, kind: 'STAY', status: 'REQUESTED',
        scheduledAt: checkIn, durationMin, notes: input.notes?.trim().slice(0, 1000) || null,
      },
      select: { id: true },
    });
    bookingId = booking.id;
  }

  const existingLink = await prisma.paymentLink.findFirst({
    where: {
      resourceType: 'BOOKING', resourceId: bookingId,
      status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { token: true, amount: true, currency: true },
  });
  if (existingLink) {
    return {
      bookingId,
      amount: Number(existingLink.amount), currency: existingLink.currency,
      url: `${env.WEB_APP_URL.replace(/\/+$/, '')}/pay/${existingLink.token}`,
    };
  }

  const price = calculateStayPrice(rates, durationMin);
  try {
    const link = await paymentLinksService.create({
      resourceType: 'BOOKING', resourceId: bookingId, customerId,
      amount: price.total, currency: property.currency,
      description: `${property.title}: ${price.days} day${price.days === 1 ? '' : 's'}`,
      allowPartial: false,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }, null);
    return { bookingId, amount: link.amount, currency: link.currency, url: link.url };
  } catch (error) {
    if (!recent) await prisma.propertyBooking.delete({ where: { id: bookingId } }).catch(() => undefined);
    throw error;
  }
}

/**
 * Turn confirmed chat picks (by product name) into a PENDING draft order the
 * business's team confirms. Names are resolved to each product's default
 * active variant; unmatched names are skipped.
 */
/** Map a conversation's channel to a valid order source so an AI-taken order is
 * attributed to the channel the customer actually used (not always web chat). */
function channelToOrderSource(channelType?: string): 'WHATSAPP' | 'INSTAGRAM' | 'TELEGRAM' | 'TIKTOK' | 'MESSENGER' | 'WEB_CHAT' | 'API' {
  switch (channelType) {
    case 'WHATSAPP': return 'WHATSAPP';
    case 'INSTAGRAM': return 'INSTAGRAM';
    case 'TELEGRAM': return 'TELEGRAM';
    case 'TIKTOK': return 'TIKTOK';
    case 'FACEBOOK_MESSENGER': return 'MESSENGER';
    case 'WEB_CHAT': return 'WEB_CHAT';
    default: return 'API'; // email/sms/other — generic non-manual source
  }
}

async function createDraftOrder(customerId: string, items: { name?: string; quantity?: number }[], channelType?: string, couponCode?: string) {
  const lines: { variantId: string; quantity: number }[] = [];
  for (const it of items) {
    const name = (it.name ?? '').trim();
    if (!name) continue;
    const quantity = Math.max(1, Math.floor(Number(it.quantity) || 1));
    const product = await prisma.product.findFirst({
      where: { deletedAt: null, status: 'ACTIVE', name: { contains: name, mode: 'insensitive' } },
      select: { variants: variantSelect },
    });
    const variantId = product?.variants[0]?.id;
    if (variantId) lines.push({ variantId, quantity });
  }
  if (lines.length === 0) throw new Error('none of the requested products were found');

  // Dedup: an eager model may re-emit the order on a repeated "yes". If an
  // identical draft was just created for this customer, reuse it.
  const recent = await prisma.order.findFirst({
    where: { customerId, status: 'PENDING', createdAt: { gte: new Date(Date.now() - 5 * 60_000) } },
    orderBy: { createdAt: 'desc' },
    select: { number: true, total: true, currency: true, couponCode: true, items: { select: { variantId: true, quantity: true } } },
  });
  const sameCart =
    recent &&
    (recent.couponCode ?? '') === (couponCode?.trim().toUpperCase() ?? '') &&
    recent.items.length === lines.length &&
    lines.every((l) => recent.items.some((r) => r.variantId === l.variantId && Number(r.quantity) === l.quantity));
  if (sameCart) return recent;

  return ordersService.create({ customerId, source: channelToOrderSource(channelType), items: lines, shippingTotal: 0, couponCode: couponCode?.trim().toUpperCase() || undefined }, null);
}

export const aiService = {
  // ------------------------------------------------ workspace assistant
  /**
   * Read-only in-app copilot. It explains workflows and helps users navigate;
   * it never mutates business data. Questions asking for analysis are subject
   * to the ai_insights entitlement, while ordinary assistance and knowledge
   * questions remain available on plans that include the assistant.
   */
  async workspaceAssistant(
    prompt: string,
    history: AiMessage[] = [],
    currentPath?: string,
  ): Promise<{ reply: string; suggestedActions: { label: string; path: string }[] }> {
    const { provider, ownKey } = await resolveAi();
    const organizationId = currentOrgId();
    const ent = await resolveEntitlements(organizationId);
    const asksForInsights =
      /\b(analytics?|analyse|analyze|insight|forecast|trend|performance|revenue|conversion rate|best selling|top customer|pipeline value)\b/i
        .test(prompt);
    if (asksForInsights && !ent.features.has('ai_insights')) {
      throw new AppError(
        'FEATURE_NOT_IN_PLAN',
        403,
        `AI analytics insights are not included in your ${ent.planName} plan. Upgrade to unlock them.`,
        { feature: 'ai_insights', plan: ent.planSlug },
      );
    }
    if (!ownKey) await aiCredits.consume(organizationId);

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true, businessType: true, currency: true },
    });
    const navigation = [
      ['Dashboard', '/'],
      ['Inbox', '/inbox'],
      ['Customers', '/customers'],
      ['CRM', '/crm'],
      ['Products', '/catalog'],
      ['Orders', '/orders'],
      ['Invoices', '/invoices'],
      ['Marketing', '/marketing'],
      ['Analytics', '/analytics'],
      ['Settings', '/settings'],
      ['Billing & plans', '/settings/billing'],
      ['Assistant knowledge', '/settings/knowledge'],
    ] as const;
    const system =
      `You are the in-app Vhicasar Hub AI Assistant for ${org.name}. Help a staff member use ` +
      `their workspace. Be direct, friendly and practical. The business type is ${org.businessType} ` +
      `and preferred currency is ${org.currency}. Current page: ${currentPath || 'unknown'}. ` +
      `You are read-only: never claim you created, changed, sent, deleted or approved anything. ` +
      `Explain the exact page and steps the user should take. Do not invent customer, financial, ` +
      `inventory or account data. If asked for data you do not have, say so and direct them to the ` +
      `relevant page. Keep answers under 180 words and use short bullets when helpful.\n` +
      `Available navigation: ${navigation.map(([label, path]) => `${label}=${path}`).join(', ')}.`;
    const reply = (await provider.complete(
      [
        { role: 'system', content: system },
        ...history
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 2_000) })),
        { role: 'user', content: prompt },
      ],
      { maxTokens: 450, temperature: 0.35 },
    )).trim();

    const lower = `${prompt} ${reply}`.toLowerCase();
    const suggestedActions = navigation
      .filter(([label, path]) =>
        lower.includes(label.toLowerCase()) ||
        (path !== '/' && lower.includes(path.slice(1).split('/')[0]!)),
      )
      .slice(0, 3)
      .map(([label, path]) => ({ label: `Open ${label}`, path }));
    return { reply, suggestedActions };
  },

  // ------------------------------------------------- conversation summary
  async summarizeConversation(conversationId: string): Promise<{ summary: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const { conversation, transcript } = await conversationTranscript(conversationId);

    const messages: AiMessage[] = [
      {
        role: 'system',
        content:
          'You summarize customer-service conversations for a CRM. Be factual and concise: ' +
          '2-4 sentences covering intent, what was discussed, and any open action item. ' +
          'No preamble, no markdown.',
      },
      {
        role: 'user',
        content: `Customer: ${conversation.customer.firstName} ${conversation.customer.lastName ?? ''} · ${conversation.customer.totalOrders} past orders.\n\nConversation:\n${transcript}`,
      },
    ];
    const summary = (await provider.complete(messages, { maxTokens: 300 })).trim();

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiSummary: summary },
    });
    return { summary };
  },

  // ---------------------------------------------------------- reply draft
  async suggestReply(conversationId: string): Promise<{ suggestion: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const { conversation, transcript } = await conversationTranscript(conversationId);

    const messages: AiMessage[] = [
      {
        role: 'system',
        content:
          'You draft replies for a customer-support agent. Write ONE reply the agent could ' +
          'send as-is: helpful, warm, concise (under 80 words), matching the customer\'s language. ' +
          'Never invent order numbers, prices, stock levels or policies — if information is ' +
          'missing, the draft should ask for it or say the agent will check. ' +
          'Output only the reply text.',
      },
      {
        role: 'user',
        content: `Channel: ${conversation.channelAccount.channelType}\nCustomer profile: ${conversation.customer.aiSummary ?? 'n/a'}\n\nConversation:\n${transcript}\n\nDraft the next agent reply.`,
      },
    ];
    const suggestion = (await provider.complete(messages, { maxTokens: 250, temperature: 0.5 })).trim();
    return { suggestion };
  },

  // ------------------------------------------------------------ sentiment
  /** Fire-and-forget on inbound messages; failures only log. */
  async analyzeSentiment(conversationId: string, lastMessage: string): Promise<void> {
    const { provider } = await resolveAiOptional();
    if (!provider) return;
    try {
      const raw = await provider.complete(
        [
          {
            role: 'system',
            content:
              'Classify the sentiment of the customer message. Respond with JSON only: ' +
              '{"sentiment":"POSITIVE"|"NEUTRAL"|"NEGATIVE"}',
          },
          { role: 'user', content: lastMessage.slice(0, 1000) },
        ],
        { maxTokens: 30, temperature: 0, jsonMode: true }
      );
      const parsed = extractJson<{ sentiment?: string }>(raw);
      const sentiment = parsed?.sentiment?.toUpperCase();
      if (sentiment && ['POSITIVE', 'NEUTRAL', 'NEGATIVE'].includes(sentiment)) {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { aiSentiment: sentiment },
        });
      }
    } catch (e) {
      logger.debug({ err: e }, 'Sentiment analysis failed (non-fatal)');
    }
  },

  // ------------------------------------------------------ customer summary
  async summarizeCustomer(customerId: string): Promise<{ summary: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { number: true, status: true, total: true, currency: true, source: true, createdAt: true },
        },
        conversations: {
          orderBy: { lastMessageAt: 'desc' },
          take: 3,
          select: { aiSummary: true, lastMessageText: true, aiSentiment: true },
        },
        identities: { select: { channelType: true } },
        tickets: { take: 5, orderBy: { createdAt: 'desc' }, select: { subject: true, status: true } },
      },
    });
    if (!customer) throw new NotFoundError('Customer');

    const facts = {
      name: `${customer.firstName} ${customer.lastName ?? ''}`.trim(),
      customerSince: customer.createdAt.toISOString().slice(0, 10),
      lifetimeValue: Number(customer.lifetimeValue),
      totalOrders: customer.totalOrders,
      channels: customer.identities.map((i) => i.channelType),
      recentOrders: customer.orders.map((o) => ({
        number: o.number, status: o.status, total: Number(o.total), source: o.source,
      })),
      recentConversations: customer.conversations.map((c) => c.aiSummary ?? c.lastMessageText),
      recentTickets: customer.tickets,
    };

    const summary = (
      await provider.complete(
        [
          {
            role: 'system',
            content:
              'You write customer profile summaries for a CRM. 3-5 sentences: who they are as ' +
              'a customer, buying behavior, preferred channels, any risks or opportunities. ' +
              'Base it ONLY on the provided facts. No preamble, no markdown.',
          },
          { role: 'user', content: JSON.stringify(facts) },
        ],
        { maxTokens: 350 }
      )
    ).trim();

    await prisma.customer.update({
      where: { id: customerId },
      data: { aiSummary: summary, aiSummaryAt: new Date() },
    });
    return { summary };
  },

  // ------------------------------------------------------------- auto-reply
  /**
   * Bot reply with handoff contract. Returns null when the bot should stay
   * silent and hand the conversation to a human.
   */
  async autoReplyDraft(
    conversationId: string,
  ): Promise<string | { text: string; mediaUrls: string[] } | null> {
    const { provider } = await resolveAiOptional();
    if (!provider) return null;
    const { conversation, transcript } = await conversationTranscript(conversationId, 20);

    // Meter against the org's AI response quota; stay silent when exhausted.
    if (!(await aiCredits.tryConsume(conversation.organizationId))) return null;

    // Ground the reply in the business's own knowledge base (website + docs).
    // Query the latest inbound directly (authoritative) rather than relying on
    // the transcript array's ordering.
    const lastInboundMsg = await prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });
    const lastInbound = lastInboundMsg?.body ?? '';
    // The widget logs a "Chat started" system line on open — don't auto-reply to
    // it; the bot greets when the visitor actually says something.
    if (!lastInbound.trim() || /^chat started/i.test(lastInbound.trim())) return null;

    const hits = await knowledgeService.search(conversation.organizationId, lastInbound, 4);
    const knowledge = hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n\n');

    // Catalog products the assistant may suggest / take an order for.
    const products = await productContext(lastInbound);
    const productsCtx = products
      .map((p) => {
        const v = p.variants[0]!;
        const price = `${v.currency} ${Number(v.price).toLocaleString()}`;
        const desc = p.description ? ` — ${p.description.slice(0, 90)}` : '';
        return `- ${p.name} [productId=${p.id}; images=${p.images.length}]: ${price}${desc}`;
      })
      .join('\n');

    // Property recommendations and stay availability. IDs are supplied only as
    // machine-action handles; customer-facing replies use titles/references.
    const properties = await propertyContext(lastInbound);
    const propertyIds = properties.map((p) => p.id);
    const upcomingPropertyBookings = propertyIds.length
      ? await prisma.propertyBooking.findMany({
          where: {
            propertyId: { in: propertyIds },
            status: { notIn: ['CANCELLED', 'NO_SHOW'] },
            scheduledAt: { gte: new Date() },
          },
          select: { propertyId: true, scheduledAt: true, durationMin: true },
          take: 80,
          orderBy: { scheduledAt: 'asc' },
        })
      : [];
    const propertiesCtx = properties.map((p) => {
      const stayRates = propertyStayRates(p);
      const amount = p.price
        ? `sale ${p.currency} ${Number(p.price).toLocaleString()}`
        : p.rentAmount
          ? `${p.rentPeriod?.toLowerCase() ?? 'rent'} ${p.currency} ${Number(p.rentAmount).toLocaleString()}`
          : 'price on request';
      const unavailable = upcomingPropertyBookings
        .filter((b) => b.propertyId === p.id)
        .slice(0, 10)
        .map((b) => {
          const end = new Date(b.scheduledAt.getTime() + b.durationMin * 60_000);
          return `${b.scheduledAt.toISOString()}..${end.toISOString()}`;
        });
      const shortStay = [
        stayRates.daily ? `daily ${p.currency} ${stayRates.daily.toLocaleString()}` : '',
        stayRates.weekly ? `weekly ${p.currency} ${stayRates.weekly.toLocaleString()}` : '',
      ].filter(Boolean).join(', ') || 'short-stay not configured';
      return `- ${p.title} [propertyId=${p.id}; ref=${p.reference}; images=${p.media.length}]: ${p.type}, ${p.purpose}, ${amount}; ${shortStay}; ` +
        `${p.bedrooms ?? '?'} bed, ${p.bathrooms ?? '?'} bath; ${[p.city, p.state].filter(Boolean).join(', ') || 'location not listed'}; ` +
        `amenities=${JSON.stringify(p.amenities ?? [])}; ${p.description?.slice(0, 140) ?? ''}; ` +
        `unavailable=${unavailable.length ? unavailable.join(',') : 'none listed'}`;
    }).join('\n');

    // Only show offers that are valid now. Coupon limits and customer-specific
    // eligibility are still enforced atomically by ordersService at creation.
    const now = new Date();
    const [coupons, promotions] = await Promise.all([
      prisma.coupon.findMany({
        where: { isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }] },
        select: { code: true, description: true, discountType: true, discountValue: true, minOrderAmount: true }, take: 12,
      }),
      prisma.promotion.findMany({
        where: { status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gte: now } },
        select: { name: true, description: true, discountType: true, discountValue: true, appliesTo: true }, take: 12,
      }),
    ]);
    const offersCtx = [
      ...coupons.map((c) => `- Code ${c.code}: ${c.description || `${Number(c.discountValue)} ${c.discountType === 'PERCENTAGE' ? '% off' : 'off'}`}${c.minOrderAmount ? ` (minimum ${Number(c.minOrderAmount)})` : ''}`),
      ...promotions.map((p) => `- ${p.name}: ${p.description || `${Number(p.discountValue)} ${p.discountType === 'PERCENTAGE' ? '% off' : 'off'}`} · appliesTo=${JSON.stringify(p.appliesTo ?? { scope: 'ALL' })}`),
    ].join('\n');

    // Appointment availability, so the assistant can offer real slots and book
    // on ANY channel (spec #12) — not just the web-chat widget. Kept to a handful
    // of upcoming slots with their exact ISO start so booking is unambiguous.
    let apptCtx = '(booking not available)';
    try {
      const av = await appointmentsService.availableSlots(conversation.organizationId, undefined, 7);
      if (av.enabled && av.slots.length > 0) {
        const typeList = av.types.length ? ` Types: ${av.types.map((t) => `${t.name} (${t.id})`).join(', ')}.` : '';
        apptCtx =
          `Timezone: ${av.timezone}.${typeList}\n` +
          av.slots.slice(0, 8).map((s) => {
            const local = new Date(s.start).toLocaleString('en-US', {
              timeZone: av.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            });
            return `- ${local} → start="${s.start}"`;
          }).join('\n');
      }
    } catch {
      /* booking optional — never block the reply */
    }

    // A default webchat visitor has no real name yet — that's our cue to ask.
    const currentName = conversation.customer.firstName?.trim() ?? '';
    // "Website visitor" is split into first/last on create, so treat those
    // placeholder tokens (and blanks) as "no real name yet".
    const knownName =
      currentName && !/^(website|visitor|guest|anonymous|website visitor|unknown)$/i.test(currentName)
        ? currentName
        : '';

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You are a friendly customer chat assistant for a business using Vhicasar Hub AI. ' +
            'Answer questions about the business — hours, products, services, policies, and any ' +
            'pricing shown — using the KNOWLEDGE below (the business\'s own website and documents). ' +
            'Set "handoff": true when the customer explicitly asks to speak to a person/agent/human, ' +
            'when the request needs private account data (a specific existing order\'s status, a ' +
            'personal refund), or when they are upset/complaining — and STILL write a short, warm ' +
            '"reply" telling them you are connecting them to the team. ' +
            'If the customer reports a problem or bug, makes a complaint, or asks to open/create a ' +
            'support ticket or case, include "ticket" with a concise subject and a priority (URGENT ' +
            'for outages/safety, HIGH for a blocked customer or complaint, otherwise MEDIUM/LOW), and ' +
            'confirm in "reply" that you have logged it for the team. ' +
            'Never invent facts, prices, or policies not present in the KNOWLEDGE. Keep replies ' +
            'under 70 words and match the customer\'s language.\n' +
            `The customer's known name is: ${knownName || 'unknown'}. If unknown, warmly greet them ` +
            'and ask their preferred name (still help with their question in the same message). When ' +
            'the customer shares their name, email, phone, address, company, birthday, preferences, ' +
            'or another useful profile detail, you MUST return it in "save" so we store it. Put ' +
            'non-contact fields in save.details as short string/number/boolean values. Split a full ' +
            'name naturally. Never infer details the customer did not actually provide. Once you know ' +
            'their name, address them by it naturally.\n' +
            'If the KNOWLEDGE below is empty or does not cover the question, still reply ' +
            'warmly and conversationally (greet, ask their name, ask what they are looking for) — ' +
            'do NOT tell the customer you lack information or business details. Only when they ask a ' +
            'specific factual question you genuinely cannot answer, briefly offer to connect them.\n' +
            'You may suggest items from PRODUCTS below using their exact names and listed prices ' +
            '(never invent products or prices). Ordering is TWO steps: (1) when the customer wants ' +
            'to buy, reply with the exact items, quantities and total and ask them to confirm — and ' +
            'do NOT include "order" in this message; (2) ONLY in a LATER message, after the customer ' +
            'explicitly confirms (e.g. "yes", "confirm", "go ahead") the order you just quoted, ' +
            'include "order.items" as [{"name","quantity"}] using exact PRODUCTS names. Never quote ' +
            'and place in the same message. Before asking for final confirmation, ask once whether they ' +
            'have a promo/coupon/voucher code, unless they already supplied one. If they give a code, ' +
            'match it case-insensitively against OFFERS and include it as order.couponCode only when ' +
            'placing the later confirmed order. Mention relevant active promotions from OFFERS without ' +
            'inventing eligibility. If a supplied code is absent from OFFERS, explain it cannot be ' +
            'verified and ask them to check it. If unsure whether they confirmed, ask again and omit "order".\n' +
            'RECOMMENDATIONS: infer practical preferences from the customer description (use case, ' +
            'location, budget, bedrooms, amenities, dates, product features) and recommend at most three ' +
            'best matches from PRODUCTS and PROPERTIES. Explain each match briefly using only listed facts. ' +
            'Ask one focused follow-up question when a critical preference is missing. Never recommend an ' +
            'unlisted item or property and never expose internal propertyId values to the customer. ' +
            'When recommending an item that has images, include it in recommendationMedia using its exact ' +
            'listed id. Include at most three recommended items and never select media for an item you did not recommend.\n' +
            'PROPERTY STAYS: for Airbnb/short-stay requests, collect check-in, check-out and the selected ' +
            'property. Treat the unavailable ranges in PROPERTIES as blocked. First quote the exact property, ' +
            'dates, nightly rate and estimated total and ask the customer to confirm and pay; OMIT stayBooking. ' +
            'ONLY in a LATER message after explicit confirmation, return stayBooking with the exact propertyId, ' +
            'ISO checkIn/checkOut and optional notes. The server rechecks availability and creates a 30-minute ' +
            'payment link. Never claim the stay is confirmed until payment succeeds; say it is held pending payment.\n' +
            'APPOINTMENTS: when the customer wants to book/schedule an appointment, viewing, or ' +
            'consultation, offer the available times from APPOINTMENTS below in the customer\'s words ' +
            '(their local, friendly time) and ask which works — do NOT include "booking" yet. ONLY in a ' +
            'LATER message, after they pick one of the offered times, include "booking" with the exact ' +
            'start ISO string copied verbatim from that slot (the value after start=), plus their name/' +
            'email/phone if known, and confirm in "reply". Never offer times not listed. If APPOINTMENTS ' +
            'says booking is unavailable, do not promise a booking — offer to connect them to the team.\n' +
            'Respond with JSON only. Shape: {"handoff": <bool>, "reply": "<text>", ' +
            '"save"?: {"name"?, "email"?, "phone"?, "details"?: {"field": "value"}}, "order"?: {"items": [{"name", "quantity"}], "couponCode"?}, ' +
            '"ticket"?: {"subject": "<short>", "priority": "LOW|MEDIUM|HIGH|URGENT"}, ' +
            '"booking"?: {"start": "<ISO from a listed slot>", "typeId"?, "notes"?}, ' +
            '"stayBooking"?: {"propertyId": "<exact listed id>", "checkIn": "<ISO>", "checkOut": "<ISO>", "notes"?}, ' +
            '"recommendationMedia"?: [{"type": "PRODUCT|PROPERTY", "id": "<exact listed id>"}]}. ' +
            'ALWAYS include a friendly "reply", even when handoff is true.\n\n' +
            `KNOWLEDGE:\n${knowledge || '(none retrieved for this message)'}\n\n` +
            `PRODUCTS:\n${productsCtx || '(no products available)'}\n\n` +
            `PROPERTIES:\n${propertiesCtx || '(no properties available)'}\n\n` +
            `OFFERS:\n${offersCtx || '(no active offers)'}\n\n` +
            `APPOINTMENTS:\n${apptCtx}`,
        },
        {
          role: 'user',
          content: `Customer: ${knownName || 'unknown name'} (${conversation.customer.totalOrders} past orders)\n\nConversation:\n${transcript}`,
        },
      ],
      { maxTokens: 250, temperature: 0.4, jsonMode: true }
    );

    const parsed = extractJson<{
      handoff?: boolean;
      reply?: string;
      save?: { name?: string; email?: string; phone?: string; details?: Record<string, string | number | boolean> };
      order?: { items?: { name?: string; quantity?: number }[]; couponCode?: string };
      ticket?: { subject?: string; priority?: string };
      booking?: { start?: string; typeId?: string; notes?: string };
      stayBooking?: { propertyId?: string; checkIn?: string; checkOut?: string; notes?: string };
      recommendationMedia?: { type?: string; id?: string }[];
    }>(raw);
    if (!parsed) return null;

    // Explicit handoff (without a ticket): alert the team AND acknowledge the
    // customer — never go silent, which is what left "connect me" doing nothing.
    if (parsed.handoff && !parsed.ticket?.subject?.trim()) {
      await notifyService
        .notifyStaff(conversation.organizationId, {
          type: 'inbox.handoff',
          title: 'Customer wants to speak with someone',
          body: `${knownName || 'A website visitor'} asked to be connected on live chat.`,
          data: { conversationId },
        })
        .catch((err) => logger.warn({ err }, 'Chat handoff notify failed'));
      return (
        parsed.reply?.trim() ||
        "Absolutely — I'm connecting you with a member of our team now. Someone will be with you shortly."
      );
    }

    let reply = parsed.reply?.trim() ?? '';

    // Place a draft order when the customer has confirmed their picks.
    if (parsed.order?.items?.length) {
      try {
        const order = await createDraftOrder(conversation.customer.id, parsed.order.items, conversation.channelAccount.channelType, parsed.order.couponCode);
        reply +=
          `\n\n✅ Draft order ${order.number} created — ${order.currency} ` +
          `${Number(order.total).toLocaleString()} total. Our team will confirm it shortly.`;
      } catch (err) {
        reply += `\n\n(I couldn't finalize that order right now — ${(err as Error).message}. I can connect you to our team.)`;
        logger.warn({ err }, 'Chat draft order failed');
      }
    }

    // Book an appointment when the customer confirmed one of the offered slots.
    // Works on every channel — the assistant offered real availability above.
    if (parsed.booking?.start) {
      try {
        const appt = await appointmentsService.book(
          conversation.organizationId,
          {
            start: parsed.booking.start,
            typeId: parsed.booking.typeId,
            notes: parsed.booking.notes,
            name: knownName || undefined,
            email: parsed.save?.email ?? conversation.customer.email ?? undefined,
            phone: parsed.save?.phone ?? conversation.customer.phone ?? undefined,
          },
          'CHAT',
          conversation.customer.id,
        );
        const when = new Date(appt.start).toLocaleString('en-US', {
          timeZone: appt.timezone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        reply += `\n\n📅 Booked! You're confirmed for ${when} (${appt.timezone}). A confirmation with calendar details is on its way.`;
      } catch (err) {
        reply += `\n\n(I couldn't book that time — ${(err as Error).message}. Would you like me to connect you to the team?)`;
        logger.warn({ err }, 'Chat appointment booking failed');
      }
    }

    // Create a short-stay hold only after the customer confirms the quoted
    // property and dates. Availability is checked again inside the helper.
    if (parsed.stayBooking?.propertyId) {
      try {
        const stay = await createStayBooking(
          conversation.organizationId,
          conversation.customer.id,
          parsed.stayBooking,
        );
        reply +=
          `\n\n🏠 Your stay is held pending payment. Pay ${stay.currency} ` +
          `${Number(stay.amount).toLocaleString()} within 30 minutes to confirm: ${stay.url}`;
      } catch (err) {
        reply += `\n\n(I couldn't hold that property — ${(err as Error).message}. Please choose another date or property.)`;
        logger.warn({ err }, 'Chat property stay booking failed');
      }
    }

    // Open a support ticket when the customer reports an issue or asks for one,
    // then alert the assignee (or the team) so someone actually follows up.
    if (parsed.ticket?.subject?.trim()) {
      try {
        let ticket = await supportService.create(
          {
            subject: parsed.ticket.subject.trim().slice(0, 200),
            description: lastInbound.slice(0, 5000),
            customerId: conversation.customer.id,
            priority: normalizePriority(parsed.ticket.priority),
          },
          { conversationId, autoRoute: true },
        );
        // Auto-routing found no agent → assign to an owner so it lands on a person.
        if (!ticket.assigneeId) {
          const owner = await prisma.membership.findFirst({
            where: { isActive: true, isOwner: true },
            select: { id: true },
          });
          if (owner) {
            await prisma.ticket
              .update({ where: { id: ticket.id }, data: { assigneeId: owner.id } })
              .catch((err) => logger.warn({ err }, 'Chat ticket auto-assign failed'));
            ticket = { ...ticket, assigneeId: owner.id };
          }
        }
        await notifyService.notifyStaff(
          conversation.organizationId,
          {
            type: 'ticket.created',
            title: `New ticket ${ticket.number}: ${ticket.subject}`,
            body: `Raised from live chat by ${knownName || 'a website visitor'}.`,
            data: { ticketId: ticket.id, conversationId },
          },
          { assigneeMembershipId: ticket.assigneeId },
        );
        reply += `${reply ? '\n\n' : ''}🎫 I've logged ticket ${ticket.number} for you — our team will follow up shortly.`;
      } catch (err) {
        logger.warn({ err }, 'Chat ticket creation failed');
        await notifyService
          .notifyStaff(conversation.organizationId, {
            type: 'inbox.handoff',
            title: 'Customer needs help (ticket auto-create failed)',
            body: `${knownName || 'A visitor'} on live chat — please review.`,
            data: { conversationId },
          })
          .catch(() => undefined);
        reply += `${reply ? '\n\n' : ''}I've alerted our team to follow up with you.`;
      }
    }

    // Persist any customer details the visitor shared during the chat.
    if (parsed.save) {
      const data: { firstName?: string; lastName?: string | null; displayName?: string; email?: string; phone?: string; customFields?: Record<string, unknown>; isProvisional?: boolean } = {};
      const name = parsed.save.name?.trim();
      if (name) {
        const [firstName, ...last] = name.split(/\s+/);
        data.firstName = firstName;
        data.lastName = last.join(' ') || null;
        data.displayName = name;
      }
      if (parsed.save.email?.trim()) data.email = parsed.save.email.trim().toLowerCase();
      if (parsed.save.phone?.trim()) data.phone = parsed.save.phone.trim();
      if (parsed.save.details && typeof parsed.save.details === 'object') {
        const existing = (conversation.customer.customFields as Record<string, unknown> | null) ?? {};
        const safe = Object.fromEntries(Object.entries(parsed.save.details).filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9 _-]{0,39}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 20));
        if (Object.keys(safe).length) data.customFields = { ...existing, ...safe };
      }
      // A provisional website visitor becomes a real customer only after the
      // customer explicitly supplies at least one useful profile detail.
      if (name || parsed.save.email?.trim() || parsed.save.phone?.trim() || data.customFields) data.isProvisional = false;
      if (Object.keys(data).length > 0) {
        await prisma.customer
          .update({ where: { id: conversation.customer.id }, data })
          .catch((err) => logger.warn({ err }, 'Saving customer detail from chat failed'));
      }
    }

    const finalReply = reply.trim();
    if (!finalReply) return null;

    const requestedMedia = (parsed.recommendationMedia ?? []).slice(0, 3);
    const fileIds: string[] = [];
    for (const item of requestedMedia) {
      const id = item.id?.trim();
      if (!id) continue;
      if (item.type?.toUpperCase() === 'PRODUCT') {
        const product = products.find((p) => p.id === id);
        if (product?.images[0]?.fileId) fileIds.push(product.images[0].fileId);
      } else if (item.type?.toUpperCase() === 'PROPERTY') {
        const property = properties.find((p) => p.id === id);
        if (property?.media[0]?.fileId) fileIds.push(property.media[0].fileId);
      }
    }
    const urls = await filesService.urlMap(fileIds);
    const mediaUrls = fileIds.map((id) => urls.get(id)).filter((url): url is string => Boolean(url));
    return mediaUrls.length ? { text: finalReply, mediaUrls } : finalReply;
  },

  // ---------------------------------------------------------- lead scoring
  async scoreLead(leadId: string): Promise<{ score: number; reason: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');
    const engagement = await entityEngagement('LEAD', leadId);

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You score sales leads 0-100 (100 = very likely to convert) using only the given ' +
            'facts: contact completeness, source quality, estimated value, status progression, ' +
            'recency, and engagement (interaction count, recency and mix of touchpoints). ' +
            'More recent, richer engagement means a higher score; a stale lead with no activity ' +
            'scores lower. Respond with JSON only: {"score": <0-100>, "reason": "<one sentence>"}',
        },
        {
          role: 'user',
          content: JSON.stringify({
            source: lead.source,
            status: lead.status,
            hasEmail: Boolean(lead.email),
            hasPhone: Boolean(lead.phone),
            estimatedValue: lead.estimatedValue ? Number(lead.estimatedValue) : null,
            ageDays: Math.floor((Date.now() - lead.createdAt.getTime()) / 86_400_000),
            engagement,
          }),
        },
      ],
      { maxTokens: 120, temperature: 0, jsonMode: true }
    );

    const parsed = extractJson<{ score?: number; reason?: string }>(raw);
    const score = Math.max(0, Math.min(100, Math.round(parsed?.score ?? 0)));
    const reason = parsed?.reason ?? 'No rationale returned';

    await prisma.lead.update({
      where: { id: leadId },
      data: { aiScore: score, aiScoreReason: reason },
    });
    return { score, reason };
  },

  // ------------------------------------------------------ deal win probability
  async scoreDeal(dealId: string): Promise<{ winProbability: number; reason: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, deletedAt: null },
      include: {
        stage: { select: { name: true, position: true, probability: true } },
        pipeline: { select: { stages: { select: { id: true } } } },
        customer: { select: { lifetimeValue: true, totalOrders: true } },
      },
    });
    if (!deal) throw new NotFoundError('Deal');
    const engagement = await entityEngagement('DEAL', dealId);

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You estimate the probability (0-100) that a sales deal will be won, using only the ' +
            'given facts: deal value, current stage and its position in the pipeline, the stage\'s ' +
            'nominal probability, age, time to expected close, customer history, and engagement. ' +
            'Later stages and active recent engagement raise the probability; stalled or aging ' +
            'deals lower it. Respond with JSON only: {"winProbability": <0-100>, "reason": "<one sentence>"}',
        },
        {
          role: 'user',
          content: JSON.stringify({
            value: Number(deal.value),
            stage: deal.stage.name,
            stagePosition: deal.stage.position,
            stageNominalProbability: deal.stage.probability,
            totalStages: deal.pipeline.stages.length,
            ageDays: Math.floor((Date.now() - deal.createdAt.getTime()) / 86_400_000),
            daysToExpectedClose: deal.expectedCloseAt
              ? Math.floor((deal.expectedCloseAt.getTime() - Date.now()) / 86_400_000)
              : null,
            customerLifetimeValue: deal.customer ? Number(deal.customer.lifetimeValue) : null,
            customerOrders: deal.customer?.totalOrders ?? null,
            engagement,
          }),
        },
      ],
      { maxTokens: 120, temperature: 0, jsonMode: true }
    );

    const parsed = extractJson<{ winProbability?: number; reason?: string }>(raw);
    const winProbability = Math.max(0, Math.min(100, Math.round(parsed?.winProbability ?? 0)));
    const reason = parsed?.reason ?? 'No rationale returned';

    await prisma.deal.update({
      where: { id: dealId },
      data: {
        aiWinProbability: winProbability,
        customFields: {
          ...((deal.customFields as Record<string, unknown> | null) ?? {}),
          aiWinReason: reason,
        },
      },
    });
    return { winProbability, reason };
  },

  // -------------------------------------------------------- next best action
  async nextBestAction(
    entityType: 'LEAD' | 'DEAL',
    id: string
  ): Promise<{ action: string; rationale: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();

    let facts: Record<string, unknown>;
    if (entityType === 'LEAD') {
      const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
      if (!lead) throw new NotFoundError('Lead');
      facts = {
        kind: 'lead',
        status: lead.status,
        source: lead.source,
        hasEmail: Boolean(lead.email),
        hasPhone: Boolean(lead.phone),
        aiScore: lead.aiScore,
        ageDays: Math.floor((Date.now() - lead.createdAt.getTime()) / 86_400_000),
      };
    } else {
      const deal = await prisma.deal.findFirst({
        where: { id, deletedAt: null },
        include: { stage: { select: { name: true } } },
      });
      if (!deal) throw new NotFoundError('Deal');
      facts = {
        kind: 'deal',
        stage: deal.stage.name,
        value: Number(deal.value),
        status: deal.status,
        aiWinProbability: deal.aiWinProbability,
        expectedCloseAt: deal.expectedCloseAt?.toISOString().slice(0, 10) ?? null,
      };
    }
    const engagement = await entityEngagement(entityType, id);

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You are an AI sales assistant. Recommend the single next best action the rep should ' +
            'take to move this ' +
            entityType.toLowerCase() +
            ' forward. Be specific and practical, grounded in the engagement history. ' +
            'The action is a short imperative (e.g. "Call to book a site inspection", ' +
            '"Send a follow-up email with pricing"). Respond with JSON only: ' +
            '{"action": "<short imperative>", "rationale": "<one sentence why>"}',
        },
        { role: 'user', content: JSON.stringify({ ...facts, engagement }) },
      ],
      { maxTokens: 150, temperature: 0.3, jsonMode: true }
    );

    const parsed = extractJson<{ action?: string; rationale?: string }>(raw);
    return {
      action: parsed?.action?.trim() || 'Follow up with the contact',
      rationale: parsed?.rationale?.trim() || '',
    };
  },

  // ---------------------------------------------------------- support tickets
  async summarizeTicket(ticketId: string): Promise<{ summary: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const { transcript } = await ticketContext(ticketId);
    const summary = (
      await provider.complete(
        [
          {
            role: 'system',
            content:
              'You summarize support tickets for an agent. 2-4 sentences: the customer issue, ' +
              'what has happened so far, and the current open action. Factual, no markdown.',
          },
          { role: 'user', content: transcript },
        ],
        { maxTokens: 250 },
      )
    ).trim();
    return { summary };
  },

  async suggestTicketReply(ticketId: string): Promise<{ suggestion: string; articles: { id: string; title: string }[] }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const { ticket, transcript } = await ticketContext(ticketId);
    const articles = await kbService.suggest(`${ticket.subject}`, 3);

    const suggestion = (
      await provider.complete(
        [
          {
            role: 'system',
            content:
              'You draft a support reply the agent can send as-is: helpful, empathetic, concise ' +
              '(under 120 words), matching the customer\'s language. Use the knowledge-base ' +
              'articles when relevant, but never invent facts, prices, order numbers or policies. ' +
              'If information is missing, ask for it. Output only the reply text.',
          },
          {
            role: 'user',
            content: `Ticket:\n${transcript}\n\nRelevant KB articles: ${articles.map((a) => a.title).join('; ') || 'none'}\n\nDraft the next reply.`,
          },
        ],
        { maxTokens: 300, temperature: 0.5 },
      )
    ).trim();
    return { suggestion, articles: articles.map((a) => ({ id: a.id, title: a.title })) };
  },

  // ------------------------------------------------------ recruitment scoring
  /** Score a candidate's fit for the role they applied to, from their CV text. */
  async scoreApplicant(applicantId: string): Promise<{ score: number; reason: string }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();
    const applicant = await prisma.applicant.findFirst({
      where: { id: applicantId },
      select: {
        firstName: true, lastName: true, resumeText: true, source: true, notes: true,
        jobPosting: { select: { title: true, description: true, employmentType: true, location: true } },
      },
    });
    if (!applicant) throw new NotFoundError('Applicant');

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You score a job candidate 0-100 for fit against the role, using ONLY the supplied ' +
            'role description and candidate CV text. Judge relevant experience, skills and ' +
            'seniority match. If the CV text is missing or too thin to judge, score low and say ' +
            'so — never invent qualifications. Ignore name, gender, age, nationality and any ' +
            'other protected characteristic; assess capability only. ' +
            'Respond with JSON only: {"score": <0-100>, "reason": "<one sentence>"}',
        },
        {
          role: 'user',
          content: JSON.stringify({
            role: {
              title: applicant.jobPosting.title,
              description: applicant.jobPosting.description?.slice(0, 4000) ?? null,
              employmentType: applicant.jobPosting.employmentType,
              location: applicant.jobPosting.location,
            },
            candidate: {
              cv: applicant.resumeText?.slice(0, 8000) ?? null,
              recruiterNotes: applicant.notes,
              source: applicant.source,
            },
          }),
        },
      ],
      { maxTokens: 150, temperature: 0, jsonMode: true },
    );

    const parsed = extractJson<{ score?: number; reason?: string }>(raw);
    const score = Math.max(0, Math.min(100, Math.round(parsed?.score ?? 0)));
    const reason = parsed?.reason ?? 'No rationale returned';
    await prisma.applicant.update({ where: { id: applicantId }, data: { aiScore: score, aiScoreReason: reason } });
    return { score, reason };
  },
};
