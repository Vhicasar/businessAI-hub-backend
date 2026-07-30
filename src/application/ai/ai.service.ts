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
import { supportService } from '../support/support.service';
import { notifyService } from '../notifications/notify.service';
import { currentOrgId, resolveEntitlements } from '../billing/entitlements';

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
          totalOrders: true, aiSummary: true, email: true, phone: true,
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
  };
  let products = await prisma.product.findMany({
    where: terms.length ? { ...base, OR: terms.map((t) => ({ name: { contains: t, mode: 'insensitive' as const } })) } : base,
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

async function createDraftOrder(customerId: string, items: { name?: string; quantity?: number }[], channelType?: string) {
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
    select: { number: true, total: true, currency: true, items: { select: { variantId: true, quantity: true } } },
  });
  const sameCart =
    recent &&
    recent.items.length === lines.length &&
    lines.every((l) => recent.items.some((r) => r.variantId === l.variantId && Number(r.quantity) === l.quantity));
  if (sameCart) return recent;

  return ordersService.create({ customerId, source: channelToOrderSource(channelType), items: lines, shippingTotal: 0 }, null);
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
  async autoReplyDraft(conversationId: string): Promise<string | null> {
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
        return `- ${p.name}: ${price}${desc}`;
      })
      .join('\n');

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
            'the customer shares their name, email, or phone, you MUST return it in "save" so we ' +
            'store it to their profile. Once you know their name, address them by it naturally.\n' +
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
            'and place in the same message. If unsure whether they confirmed, ask again and omit "order".\n' +
            'APPOINTMENTS: when the customer wants to book/schedule an appointment, viewing, or ' +
            'consultation, offer the available times from APPOINTMENTS below in the customer\'s words ' +
            '(their local, friendly time) and ask which works — do NOT include "booking" yet. ONLY in a ' +
            'LATER message, after they pick one of the offered times, include "booking" with the exact ' +
            'start ISO string copied verbatim from that slot (the value after start=), plus their name/' +
            'email/phone if known, and confirm in "reply". Never offer times not listed. If APPOINTMENTS ' +
            'says booking is unavailable, do not promise a booking — offer to connect them to the team.\n' +
            'Respond with JSON only. Shape: {"handoff": <bool>, "reply": "<text>", ' +
            '"save"?: {"name"?, "email"?, "phone"?}, "order"?: {"items": [{"name", "quantity"}]}, ' +
            '"ticket"?: {"subject": "<short>", "priority": "LOW|MEDIUM|HIGH|URGENT"}, ' +
            '"booking"?: {"start": "<ISO from a listed slot>", "typeId"?, "notes"?}}. ' +
            'ALWAYS include a friendly "reply", even when handoff is true.\n\n' +
            `KNOWLEDGE:\n${knowledge || '(none retrieved for this message)'}\n\n` +
            `PRODUCTS:\n${productsCtx || '(no products available)'}\n\n` +
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
      save?: { name?: string; email?: string; phone?: string };
      order?: { items?: { name?: string; quantity?: number }[] };
      ticket?: { subject?: string; priority?: string };
      booking?: { start?: string; typeId?: string; notes?: string };
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
        const order = await createDraftOrder(conversation.customer.id, parsed.order.items, conversation.channelAccount.channelType);
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
      const data: { firstName?: string; displayName?: string; email?: string; phone?: string } = {};
      const name = parsed.save.name?.trim();
      if (name) {
        data.firstName = name;
        data.displayName = name;
      }
      if (parsed.save.email?.trim()) data.email = parsed.save.email.trim().toLowerCase();
      if (parsed.save.phone?.trim()) data.phone = parsed.save.phone.trim();
      if (Object.keys(data).length > 0) {
        await prisma.customer
          .update({ where: { id: conversation.customer.id }, data })
          .catch((err) => logger.warn({ err }, 'Saving customer detail from chat failed'));
      }
    }

    return reply.trim() || null;
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
