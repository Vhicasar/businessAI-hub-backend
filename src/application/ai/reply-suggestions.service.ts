import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, NotFoundError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { extractJson, type AiMessage } from './ai-provider';
import { resolveAi } from './org-ai.service';
import { aiCredits } from '../billing/ai-credits';
import { knowledgeService } from '../knowledge/knowledge.service';

/** The angles a reply can take (§7). Each is a different intent, not a style. */
export const REPLY_TONES = {
  PROFESSIONAL: 'Correct, neutral and efficient. Suitable for any customer.',
  FRIENDLY: 'Warm and personable, still concise.',
  UPSELL: 'Answers the question first, then suggests a relevant product or upgrade — never pushy, and only ever something the business actually offers.',
  FOLLOW_UP: 'Confirms what happens next and when the customer will hear back.',
  APPOINTMENT: 'Confirms or proposes a specific appointment, restating date, time and place.',
  COMPLAINT: 'Acknowledges the problem plainly, takes responsibility where due, states the remedy. No defensiveness.',
  URGENT: 'Short and immediate, for a customer who needs an answer now.',
} as const;

export type ReplyTone = keyof typeof REPLY_TONES;

export interface ReplySuggestion {
  id: string;
  tone: ReplyTone;
  label: string;
  content: string;
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new AppError('NO_TENANT', 403, 'Organization context required');
  return id;
}

const TONE_LABELS: Record<ReplyTone, string> = {
  PROFESSIONAL: 'Professional',
  FRIENDLY: 'Friendly',
  UPSELL: 'Suggest an upgrade',
  FOLLOW_UP: 'Follow-up',
  APPOINTMENT: 'Confirm appointment',
  COMPLAINT: 'Resolve complaint',
  URGENT: 'Urgent',
};

/**
 * Everything the assistant is allowed to draw on (§7): the conversation, who
 * the customer is, what they have bought and booked, the business's own
 * policies, and the knowledge base.
 *
 * Assembled here rather than in the prompt so it is obvious exactly what the
 * model can see — and so it can never see another tenant's data.
 */
async function gatherContext(conversationId: string) {
  const organizationId = orgId();

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
    include: {
      customer: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          lifetimeValue: true, totalOrders: true, aiSummary: true,
        },
      },
      channelAccount: { select: { channelType: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { direction: true, authorType: true, body: true, contentType: true, createdAt: true },
      },
    },
  });
  if (!conversation) throw new NotFoundError('Conversation');

  const transcript = [...conversation.messages]
    .reverse()
    .map((m) => {
      const who = m.direction === 'INBOUND' ? 'Customer' : m.authorType === 'BOT' ? 'Bot' : 'Agent';
      return `${who}: ${m.body ?? `[${m.contentType.toLowerCase()}]`}`;
    })
    .join('\n');

  const customerId = conversation.customer?.id;

  // Recent history, so a reply can reference the actual order or booking the
  // customer means rather than asking them to repeat it.
  const [orders, appointments, invoices, org] = await Promise.all([
    customerId
      ? prisma.order.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { number: true, status: true, paymentStatus: true, total: true, currency: true, createdAt: true },
        })
      : [],
    customerId
      ? prisma.meeting.findMany({
          where: { customerId, startAt: { gte: new Date() } },
          orderBy: { startAt: 'asc' },
          take: 3,
          select: { title: true, startAt: true, location: true, status: true },
        })
      : [],
    customerId
      ? prisma.invoice.findMany({
          where: { customerId, status: { notIn: ['PAID', 'VOID'] } },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { number: true, total: true, amountPaid: true, currency: true, dueAt: true },
        })
      : [],
    prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true, businessType: true, currency: true, settings: true },
    }),
  ]);

  // The knowledge base answers "what is our policy on…" — searched with the
  // customer's own last message so the snippets are actually relevant.
  const lastInbound = [...conversation.messages].find((m) => m.direction === 'INBOUND')?.body ?? '';
  let knowledge: string[] = [];
  if (lastInbound.trim().length > 3) {
    try {
      const hits = await knowledgeService.search(organizationId, lastInbound.slice(0, 400), 3);
      knowledge = hits.map((h: { content?: string; text?: string }) => (h.content ?? h.text ?? '').slice(0, 500));
    } catch (e) {
      logger.debug({ err: e }, 'Knowledge search unavailable for reply suggestions');
    }
  }

  const policies = ((org.settings as Record<string, unknown> | null)?.policies ?? {}) as Record<string, unknown>;

  return { conversation, transcript, orders, appointments, invoices, org, knowledge, policies, organizationId };
}

function contextBlock(ctx: Awaited<ReturnType<typeof gatherContext>>): string {
  const c = ctx.conversation.customer;
  return [
    `BUSINESS: ${ctx.org.name} (${ctx.org.businessType}), currency ${ctx.org.currency}.`,
    Object.keys(ctx.policies).length > 0 ? `POLICIES: ${JSON.stringify(ctx.policies).slice(0, 800)}` : 'POLICIES: none recorded.',
    c
      ? `CUSTOMER: ${[c.firstName, c.lastName].filter(Boolean).join(' ') || 'unnamed'} · ` +
        `${c.totalOrders} order(s) · lifetime value ${c.lifetimeValue} · ` +
        `${c.aiSummary ?? 'no summary'}`
      : 'CUSTOMER: not linked to a CRM record.',
    ctx.orders.length
      ? `RECENT ORDERS:\n${ctx.orders.map((o) => `- ${o.number}: ${o.status}/${o.paymentStatus}, ${o.currency} ${o.total}`).join('\n')}`
      : 'RECENT ORDERS: none.',
    ctx.invoices.length
      ? `OPEN INVOICES:\n${ctx.invoices.map((i) => `- ${i.number}: ${i.currency} ${i.total} (paid ${i.amountPaid})${i.dueAt ? `, due ${i.dueAt.toISOString().slice(0, 10)}` : ''}`).join('\n')}`
      : 'OPEN INVOICES: none.',
    ctx.appointments.length
      ? `UPCOMING APPOINTMENTS:\n${ctx.appointments.map((a) => `- ${a.title} at ${a.startAt.toISOString()}${a.location ? ` (${a.location})` : ''}`).join('\n')}`
      : 'UPCOMING APPOINTMENTS: none.',
    ctx.knowledge.length ? `KNOWLEDGE BASE:\n${ctx.knowledge.join('\n---\n')}` : 'KNOWLEDGE BASE: nothing relevant found.',
    `CHANNEL: ${ctx.conversation.channelAccount.channelType}`,
    `CONVERSATION:\n${ctx.transcript}`,
  ].join('\n\n');
}

export const replySuggestions = {
  REPLY_TONES,

  /**
   * Draft several replies at different angles (§7).
   *
   * Nothing here sends anything: the suggestions are returned for a human to
   * pick from and edit. That is the whole contract — "No message should be sent
   * automatically without user confirmation."
   */
  async generate(
    conversationId: string,
    opts: { tones?: ReplyTone[]; userId?: string } = {}
  ): Promise<{ items: ReplySuggestion[] }> {
    const { provider, ownKey } = await resolveAi();
    if (!ownKey) await aiCredits.consume();

    const ctx = await gatherContext(conversationId);

    // Which angles make sense depends on the conversation. Offering "confirm
    // appointment" when there is no booking would just waste a suggestion slot.
    const requested =
      opts.tones ??
      ([
        'PROFESSIONAL',
        'FRIENDLY',
        ctx.appointments.length > 0 ? 'APPOINTMENT' : null,
        ctx.invoices.length > 0 ? 'FOLLOW_UP' : null,
        (ctx.conversation.aiSentiment === 'NEGATIVE' ? 'COMPLAINT' : 'UPSELL'),
      ].filter(Boolean) as ReplyTone[]);

    const tones = [...new Set(requested)].slice(0, 5);

    const messages: AiMessage[] = [
      {
        role: 'system',
        content:
          `You draft replies for a support agent at ${ctx.org.name}. Produce one draft per requested ` +
          `tone. Rules that override everything else:\n` +
          `- Use ONLY the facts in CUSTOMER DATA. Never invent an order number, price, date, stock ` +
          `level, policy or promise.\n` +
          `- If the answer is not in the data, the draft should say the agent will check.\n` +
          `- Match the customer's language.\n` +
          `- Under 80 words each. No greetings longer than one line.\n` +
          `- These are drafts a human will review; never imply the message has been sent.\n\n` +
          `Respond with JSON only: {"replies":[{"tone":"PROFESSIONAL","content":"…"}]}`,
      },
      {
        role: 'user',
        content:
          `CUSTOMER DATA:\n${contextBlock(ctx)}\n\n` +
          `Requested tones:\n${tones.map((t) => `- ${t}: ${REPLY_TONES[t]}`).join('\n')}\n\n` +
          `Draft the next agent reply for each tone.`,
      },
    ];

    const raw = await provider.complete(messages, { maxTokens: 900, temperature: 0.55, jsonMode: true });
    const parsed = extractJson<{ replies?: { tone?: string; content?: string }[] }>(raw);

    const drafts = (parsed?.replies ?? [])
      .filter((r) => typeof r.content === 'string' && r.content.trim().length > 0)
      .map((r) => ({
        tone: (tones.includes(r.tone?.toUpperCase() as ReplyTone)
          ? (r.tone!.toUpperCase() as ReplyTone)
          : 'PROFESSIONAL') as ReplyTone,
        content: r.content!.trim(),
      }));

    if (drafts.length === 0) {
      throw new AppError('AI_NO_SUGGESTION', 502, 'The assistant could not draft a reply. Try again.');
    }

    // Logged so there is always a record of what was offered, separate from
    // what a human actually chose to send.
    const rows = await prismaUnscoped.$transaction(
      drafts.map((d) =>
        prismaUnscoped.aiReplySuggestion.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId,
            tone: d.tone,
            content: d.content,
            requestedByUserId: opts.userId ?? null,
          },
        })
      )
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        tone: row.tone as ReplyTone,
        label: TONE_LABELS[row.tone as ReplyTone] ?? row.tone,
        content: row.content,
      })),
    };
  },

  /**
   * Record that a staff member actually used a suggestion.
   *
   * Called when the reply is sent, not when it is picked — and `wasEdited`
   * tells us whether the draft was good enough to send unchanged, which is the
   * only honest measure of whether this feature is working.
   */
  async markUsed(id: string, sentContent: string) {
    const organizationId = orgId();
    const row = await prismaUnscoped.aiReplySuggestion.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundError('Suggestion');

    return prismaUnscoped.aiReplySuggestion.update({
      where: { id },
      data: { usedAt: new Date(), wasEdited: sentContent.trim() !== row.content.trim() },
    });
  },
};
