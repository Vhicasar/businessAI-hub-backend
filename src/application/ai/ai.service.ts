import { AppError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { getAiProvider } from '../../infrastructure/ai';
import { extractJson, type AiMessage } from './ai-provider';
import { aiCredits } from '../billing/ai-credits';

function requireAi() {
  const provider = getAiProvider();
  if (!provider) {
    throw new AppError(
      'AI_DISABLED',
      503,
      'AI is not configured. Set AI_PROVIDER, AI_API_KEY and AI_MODEL in the backend environment.'
    );
  }
  return provider;
}

async function conversationTranscript(conversationId: string, limit = 50) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
    include: {
      customer: {
        select: {
          id: true, firstName: true, lastName: true, lifetimeValue: true,
          totalOrders: true, aiSummary: true,
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

export const aiService = {
  // ------------------------------------------------- conversation summary
  async summarizeConversation(conversationId: string): Promise<{ summary: string }> {
    const provider = requireAi();
    await aiCredits.consume();
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
    const provider = requireAi();
    await aiCredits.consume();
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
    const provider = getAiProvider();
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
    const provider = requireAi();
    await aiCredits.consume();
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
    const provider = getAiProvider();
    if (!provider) return null;
    const { conversation, transcript } = await conversationTranscript(conversationId, 20);

    // Meter against the org's AI response quota; stay silent when exhausted.
    if (!(await aiCredits.tryConsume(conversation.organizationId))) return null;

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You are a first-line customer support bot for a business using BusinessHub AI. ' +
            'Reply helpfully to simple questions (greetings, hours, general product interest, ' +
            'thanks). You MUST hand off to a human when: the customer asks about a specific ' +
            'order, price, stock, refund, complaint, or anything requiring account data; the ' +
            'customer is upset; you are not confident. Never invent facts. Match the customer\'s ' +
            'language. Keep replies under 60 words.\n' +
            'Respond with JSON only: {"handoff": true} OR {"handoff": false, "reply": "<text>"}',
        },
        {
          role: 'user',
          content: `Customer: ${conversation.customer.firstName} (${conversation.customer.totalOrders} past orders)\n\nConversation:\n${transcript}`,
        },
      ],
      { maxTokens: 200, temperature: 0.4, jsonMode: true }
    );

    const parsed = extractJson<{ handoff?: boolean; reply?: string }>(raw);
    if (!parsed || parsed.handoff || !parsed.reply?.trim()) return null;
    return parsed.reply.trim();
  },

  // ---------------------------------------------------------- lead scoring
  async scoreLead(leadId: string): Promise<{ score: number; reason: string }> {
    const provider = requireAi();
    await aiCredits.consume();
    const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundError('Lead');

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You score sales leads 0-100 (100 = very likely to convert) using only the given ' +
            'facts: contact completeness, source quality, estimated value, status progression, ' +
            'recency. Respond with JSON only: {"score": <0-100>, "reason": "<one sentence>"}',
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
};
