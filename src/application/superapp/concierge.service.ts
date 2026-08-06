import { activityCenter } from './activity-center.service';
import { resolveOrgAi } from '../ai/org-ai.service';
import type { AiMessage } from '../ai/ai-provider';

export interface ConciergeAction {
  label: string;
  deeplink: string;
}

export interface ConciergeAnswer {
  reply: string;
  actions: ConciergeAction[];
  /** True when a language model produced the wording. */
  ai: boolean;
}

/**
 * Everything the concierge is allowed to know about this customer. Built from
 * the same aggregates the dashboard renders, so the assistant can never claim
 * something the customer cannot see for themselves.
 */
async function groundingFor(vhicasarId: string, currency: string) {
  const [dashboard, upcoming, insights, timeline] = await Promise.all([
    activityCenter.dashboard(vhicasarId, currency),
    activityCenter.upcomingActions(vhicasarId, currency),
    activityCenter.insights(vhicasarId, currency),
    activityCenter.timeline(vhicasarId, { limit: 8 }),
  ]);
  return { dashboard, upcoming, insights, timeline };
}

type Grounding = Awaited<ReturnType<typeof groundingFor>>;

/**
 * Deterministic answers for the questions customers actually ask (§15).
 *
 * Patterns are stems, not whole words: "points", "offers" and "bookings" are
 * how people actually phrase these, and a trailing \b would miss every plural.
 *
 * These run before the model and are used verbatim when they match. A balance
 * or a due date must come from the ledger, not from a language model that might
 * paraphrase a number — and this also keeps the concierge working when no AI
 * provider is configured at all.
 */
function factualAnswer(question: string, g: Grounding): ConciergeAnswer | null {
  const q = question.toLowerCase();
  const { dashboard, upcoming, insights } = g;
  const cur = dashboard.wallet.currency;

  if (/\b(owe|owing|due|outstanding|unpaid|bill)/.test(q)) {
    const bills = upcoming.items.filter((i) => i.kind.startsWith('INVOICE'));
    if (bills.length === 0) {
      return {
        reply: `You have nothing outstanding right now. Your total pending payments are ${cur} ${dashboard.pendingPayments.total}.`,
        actions: [{ label: 'See your activity', deeplink: 'vhicasar://notifications' }],
        ai: false,
      };
    }
    const lines = bills
      .map((b) => `• ${b.title} — ${b.currency ?? cur} ${b.amount}${b.detail ? ` (${b.detail})` : ''}`)
      .join('\n');
    return {
      reply: `You owe ${cur} ${dashboard.pendingPayments.total} across ${bills.length} bill(s):\n${lines}`,
      actions: bills
        .filter((b) => b.deeplink)
        .slice(0, 3)
        .map((b) => ({ label: `Pay ${b.title}`, deeplink: b.deeplink! })),
      ai: false,
    };
  }

  if (/\b(appointment|booking|book|scheduled|next visit)/.test(q)) {
    const bookings = upcoming.items.filter((i) => i.kind.startsWith('BOOKING'));
    if (bookings.length === 0) {
      return {
        reply: 'You have no upcoming appointments.',
        actions: [{ label: 'Your businesses', deeplink: 'vhicasar://businesses' }],
        ai: false,
      };
    }
    const next = bookings[0]!;
    return {
      reply: `Your next appointment is ${next.title}${next.detail ? ` — ${next.detail}` : ''}.`,
      actions: next.deeplink ? [{ label: 'View booking', deeplink: next.deeplink }] : [],
      ai: false,
    };
  }

  if (/\b(offer|promo|discount|deal|expir)/.test(q)) {
    const expiring = insights.items.filter((i) => i.kind === 'PROMOTIONS_EXPIRING' || i.kind === 'REWARDS_EXPIRING');
    if (expiring.length === 0) {
      return {
        reply: `You have ${dashboard.activePromotions} active offer(s) and none expiring in the next few days.`,
        actions: [{ label: 'Your businesses', deeplink: 'vhicasar://businesses' }],
        ai: false,
      };
    }
    return {
      reply: expiring.map((i) => `• ${i.message}`).join('\n'),
      actions: expiring
        .filter((i) => i.deeplink)
        .slice(0, 3)
        .map((i) => ({ label: i.action ?? 'View', deeplink: i.deeplink! })),
      ai: false,
    };
  }

  if (/\b(balance|wallet|money|funds|locked)/.test(q)) {
    return {
      reply:
        `Your total balance is ${cur} ${dashboard.wallet.total}: ` +
        `${cur} ${dashboard.wallet.available} available, ` +
        `${cur} ${dashboard.wallet.locked} locked and ` +
        `${cur} ${dashboard.wallet.reward} in rewards.`,
      actions: [{ label: 'Open wallet', deeplink: 'vhicasar://wallet' }],
      ai: false,
    };
  }

  if (/\b(point|loyalty|reward|tier)/.test(q)) {
    return {
      reply:
        `You have ${dashboard.loyaltyPoints} loyalty point(s) across your businesses and ` +
        `${dashboard.rewards.balance} Vhicasar reward point(s)` +
        `${dashboard.rewards.tier ? ` (${dashboard.rewards.tier} tier)` : ''}.`,
      actions: [{ label: 'Open rewards', deeplink: 'vhicasar://rewards' }],
      ai: false,
    };
  }

  return null;
}

/** Compact, factual context handed to the model. */
function promptContext(g: Grounding): string {
  const { dashboard: d, upcoming, insights } = g;
  const cur = d.wallet.currency;
  return [
    `Wallet: total ${cur} ${d.wallet.total} (available ${d.wallet.available}, locked ${d.wallet.locked}, reward ${d.wallet.reward}).`,
    `Loyalty points: ${d.loyaltyPoints}. Vhicasar reward points: ${d.rewards.balance}${d.rewards.tier ? ` (${d.rewards.tier})` : ''}.`,
    `Linked businesses: ${d.businesses.total}. Active offers: ${d.activePromotions}. Active orders: ${d.activeOrders}. Upcoming bookings: ${d.upcomingBookings}.`,
    `Outstanding: ${cur} ${d.pendingPayments.total} across ${d.pendingPayments.count} bill(s).`,
    upcoming.items.length
      ? `Needs attention:\n${upcoming.items.map((i) => `- [${i.kind}] ${i.title}${i.amount ? ` ${i.currency ?? cur} ${i.amount}` : ''}${i.detail ? ` (${i.detail})` : ''}`).join('\n')}`
      : 'Needs attention: nothing.',
    insights.items.length
      ? `Insights:\n${insights.items.map((i) => `- ${i.message}`).join('\n')}`
      : 'Insights: none.',
    g.timeline.items.length
      ? `Recent activity:\n${g.timeline.items.map((t) => `- [${t.kind}] ${t.title}${t.businessName ? ` @ ${t.businessName}` : ''}`).join('\n')}`
      : 'Recent activity: none.',
  ].join('\n');
}

/**
 * The AI Business Concierge (§15): one assistant that can answer across every
 * business the customer belongs to.
 *
 * Read-only by construction — it has no tools and its whole world is the
 * grounding block above, so it cannot move money or change a booking.
 */
export const concierge = {
  async ask(
    vhicasarId: string,
    question: string,
    history: AiMessage[] = [],
    currency = 'NGN'
  ): Promise<ConciergeAnswer> {
    const grounding = await groundingFor(vhicasarId, currency);

    const factual = factualAnswer(question, grounding);
    if (factual) return factual;

    // The customer is not a tenant, so this resolves to the platform provider.
    const { provider } = await resolveOrgAi();
    if (!provider) {
      return {
        reply:
          'I can tell you about your balances, what you owe, your next appointment and offers ' +
          'that are expiring. Try asking one of those.',
        actions: [{ label: 'Open your dashboard', deeplink: 'vhicasar://notifications' }],
        ai: false,
      };
    }

    const system =
      'You are the Vhicasar concierge for one customer. Answer only from the CUSTOMER DATA below. ' +
      'Never invent a balance, amount, date, business name or offer. If the answer is not in the ' +
      'data, say you do not have it and suggest where in the app to look. You are read-only: never ' +
      'claim you paid, booked, cancelled or changed anything. Keep answers under 120 words.\n\n' +
      `CUSTOMER DATA:\n${promptContext(grounding)}`;

    const reply = (
      await provider.complete(
        [
          { role: 'system', content: system },
          ...history
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-8)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 1_500) })),
          { role: 'user', content: question },
        ],
        { maxTokens: 350, temperature: 0.2 }
      )
    ).trim();

    // Only ever offer actions the grounding actually contains, so a suggestion
    // can never point at a record the customer does not have.
    const actions: ConciergeAction[] = [
      ...grounding.upcoming.items
        .filter((i) => i.deeplink)
        .map((i) => ({ label: i.title, deeplink: i.deeplink! })),
      ...grounding.insights.items
        .filter((i) => i.deeplink)
        .map((i) => ({ label: i.action ?? 'View', deeplink: i.deeplink! })),
    ].slice(0, 3);

    return { reply, actions, ai: true };
  },

  /** Starter questions the app shows before the customer types anything. */
  async suggestions(vhicasarId: string, currency = 'NGN'): Promise<string[]> {
    const [dashboard, upcoming] = await Promise.all([
      activityCenter.dashboard(vhicasarId, currency),
      activityCenter.upcomingActions(vhicasarId, currency),
    ]);
    const out: string[] = [];
    if (dashboard.pendingPayments.count > 0) out.push('What do I owe?');
    if (upcoming.items.some((i) => i.kind.startsWith('BOOKING'))) out.push('When is my next appointment?');
    if (dashboard.activePromotions > 0) out.push('Which offers expire soon?');
    out.push('What is my balance?');
    if (dashboard.loyaltyPoints > 0) out.push('How many points do I have?');
    return out.slice(0, 4);
  },
};
