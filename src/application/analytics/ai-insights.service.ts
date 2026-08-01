import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { getAiProvider } from '../../infrastructure/ai';
import { logger } from '../../shared/logger';
import { previousRange, type DateRange } from '../../shared/date-range';

/**
 * AI Insights dashboard (spec #16): org-wide business intelligence. Gathers a
 * compact cross-domain snapshot (sales, customers, CRM, inventory, finance,
 * support, marketing) over the selected range, then asks the active AI provider
 * for an executive summary plus recommendations, risks, opportunities and a
 * one-line read per area. Everything degrades to heuristics when AI is off, so
 * the dashboard is always populated.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: unknown) => Number(d ?? 0);

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

const COUNTED_ORDER_STATUSES = [
  'CONFIRMED', 'PROCESSING', 'PICKING', 'PACKING', 'READY_FOR_DISPATCH',
  'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED',
] as const;

const pctDelta = (cur: number, prev: number): number | null =>
  prev > 0 ? round2(((cur - prev) / prev) * 100) : cur > 0 ? 100 : null;

export interface BusinessSnapshot {
  sales: { orders: number; revenue: number; revenueDelta: number | null; avgOrderValue: number };
  customers: { total: number; newInPeriod: number };
  crm: { openDeals: number; pipelineValue: number; wonValue: number; wonCount: number; lostCount: number; newLeads: number };
  inventory: { lowStock: number; outOfStock: number };
  finance: { outstanding: number; overdue: number; overdueCount: number };
  support: { openTickets: number; resolvedInPeriod: number };
  marketing: { campaignsSent: number; messagesSent: number; opened: number; clicked: number };
}

export const aiInsightsService = {
  /** Compute the raw cross-domain snapshot for the period. */
  async snapshot(range: DateRange): Promise<BusinessSnapshot> {
    const { from, to } = range;
    const prev = previousRange(range);
    const inRange = { gte: from, lte: to };

    const [
      orders, prevPaid, curPaid, newCustomers, totalCustomers,
      openDeals, wonDeals, lostCount, newLeads,
      stockLevels, invoices, openTickets, resolvedTickets, campaigns,
    ] = await Promise.all([
      prisma.order.count({ where: { createdAt: inRange, status: { in: [...COUNTED_ORDER_STATUSES] } } }),
      prisma.payment.aggregate({ where: { status: 'PAID', createdAt: { gte: prev.from, lte: prev.to } }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { status: 'PAID', createdAt: inRange }, _sum: { amount: true } }),
      prisma.customer.count({ where: { deletedAt: null, isProvisional: false, createdAt: inRange } }),
      prisma.customer.count({ where: { deletedAt: null, isProvisional: false } }),
      prisma.deal.findMany({ where: { deletedAt: null, status: 'OPEN' }, select: { value: true } }),
      prisma.deal.findMany({ where: { deletedAt: null, status: 'WON', closedAt: inRange }, select: { value: true } }),
      prisma.deal.count({ where: { deletedAt: null, status: 'LOST', closedAt: inRange } }),
      prisma.lead.count({ where: { deletedAt: null, createdAt: inRange } }),
      prisma.stockLevel.findMany({ select: { quantity: true, reorderPoint: true } }),
      prisma.invoice.findMany({ where: { status: { notIn: ['PAID', 'VOID', 'DRAFT'] } }, select: { total: true, amountPaid: true, dueAt: true } }),
      prisma.ticket.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
      prisma.ticket.count({ where: { status: { in: ['RESOLVED', 'CLOSED'] }, updatedAt: inRange } }),
      prisma.campaign.findMany({ where: { deletedAt: null, status: 'SENT', updatedAt: inRange }, select: { stats: true } }),
    ]);

    const revenue = round2(num(curPaid._sum.amount));
    const prevRevenue = round2(num(prevPaid._sum.amount));

    let lowStock = 0, outOfStock = 0;
    for (const s of stockLevels) {
      const q = num(s.quantity);
      if (q <= 0) outOfStock += 1;
      else if (s.reorderPoint != null && q <= num(s.reorderPoint)) lowStock += 1;
    }

    const now = Date.now();
    let outstanding = 0, overdue = 0, overdueCount = 0;
    for (const inv of invoices) {
      const bal = num(inv.total) - num(inv.amountPaid);
      if (bal <= 0) continue;
      outstanding += bal;
      if (inv.dueAt && inv.dueAt.getTime() < now) { overdue += bal; overdueCount += 1; }
    }

    let messagesSent = 0, opened = 0, clicked = 0;
    for (const c of campaigns) {
      const st = (c.stats as Record<string, number> | null) ?? {};
      messagesSent += num(st.sent);
      opened += num(st.opened);
      clicked += num(st.clicked);
    }

    const pipelineValue = round2(openDeals.reduce((s, d) => s + num(d.value), 0));
    const wonValue = round2(wonDeals.reduce((s, d) => s + num(d.value), 0));

    return {
      sales: { orders, revenue, revenueDelta: pctDelta(revenue, prevRevenue), avgOrderValue: orders > 0 ? round2(revenue / orders) : 0 },
      customers: { total: totalCustomers, newInPeriod: newCustomers },
      crm: { openDeals: openDeals.length, pipelineValue, wonValue, wonCount: wonDeals.length, lostCount, newLeads },
      inventory: { lowStock, outOfStock },
      finance: { outstanding: round2(outstanding), overdue: round2(overdue), overdueCount },
      support: { openTickets, resolvedInPeriod: resolvedTickets },
      marketing: { campaignsSent: campaigns.length, messagesSent, opened, clicked },
    };
  },

  /** The full dashboard payload: snapshot + AI (or heuristic) narrative. */
  async dashboard(range: DateRange) {
    const snapshot = await this.snapshot(range);
    const heuristics = heuristicNarrative(snapshot);
    const provider = getAiProvider();

    let narrative = { source: 'heuristic' as 'heuristic' | 'ai', ...heuristics };
    if (provider) {
      try {
        const raw = await provider.complete(
          [
            {
              role: 'system',
              content:
                'You are a business intelligence analyst. Given a company\'s KPI snapshot for a period, return STRICT JSON: ' +
                '{"summary": string, "recommendations": string[], "risks": string[], "opportunities": string[], ' +
                '"byArea": {"sales": string, "customers": string, "crm": string, "inventory": string, "finance": string, "support": string, "marketing": string}}. ' +
                'Each string is one concrete, actionable sentence grounded in the numbers. 2-4 items per list. No markdown, no extra keys.',
            },
            { role: 'user', content: `Period: ${range.days} days.\nSnapshot: ${JSON.stringify(snapshot)}` },
          ],
          { maxTokens: 600, temperature: 0.4 },
        );
        const p = JSON.parse(extractJson(raw)) as typeof heuristics;
        narrative = {
          source: 'ai',
          summary: p.summary || heuristics.summary,
          recommendations: arr(p.recommendations, heuristics.recommendations),
          risks: arr(p.risks, heuristics.risks),
          opportunities: arr(p.opportunities, heuristics.opportunities),
          byArea: { ...heuristics.byArea, ...(p.byArea ?? {}) },
        };
      } catch (err) {
        logger.info({ err: (err as Error).message }, 'AI insights fell back to heuristics');
      }
    }

    return {
      period: { days: range.days, from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      snapshot,
      ...narrative,
    };
  },
};

const arr = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === 'string') : fallback;

interface Narrative {
  summary: string;
  recommendations: string[];
  risks: string[];
  opportunities: string[];
  byArea: Record<'sales' | 'customers' | 'crm' | 'inventory' | 'finance' | 'support' | 'marketing', string>;
}

function heuristicNarrative(s: BusinessSnapshot): Narrative {
  const recommendations: string[] = [];
  const risks: string[] = [];
  const opportunities: string[] = [];

  if (s.finance.overdueCount > 0) {
    recommendations.push(`Chase ${s.finance.overdueCount} overdue invoice(s) worth ${s.finance.overdue.toLocaleString()} to free up cash.`);
    risks.push(`${s.finance.overdue.toLocaleString()} is overdue across ${s.finance.overdueCount} invoice(s).`);
  }
  if (s.inventory.outOfStock > 0) risks.push(`${s.inventory.outOfStock} product variant(s) are out of stock — lost sales risk.`);
  if (s.inventory.lowStock > 0) recommendations.push(`Reorder ${s.inventory.lowStock} low-stock item(s) before they run out.`);
  if (s.crm.pipelineValue > 0) opportunities.push(`${s.crm.openDeals} open deal(s) worth ${s.crm.pipelineValue.toLocaleString()} in the pipeline — prioritise follow-ups.`);
  if (s.support.openTickets > 5) risks.push(`${s.support.openTickets} support tickets are still open.`);
  if (s.sales.revenueDelta != null && s.sales.revenueDelta < 0) risks.push(`Revenue is down ${Math.abs(s.sales.revenueDelta)}% versus the previous period.`);
  if (s.sales.revenueDelta != null && s.sales.revenueDelta > 0) opportunities.push(`Revenue is up ${s.sales.revenueDelta}% — double down on what's working.`);
  if (s.customers.newInPeriod > 0) opportunities.push(`${s.customers.newInPeriod} new customer(s) acquired — nurture them into repeat buyers.`);
  if (recommendations.length === 0) recommendations.push('Metrics are stable — keep monitoring and invest in your best-performing channel.');

  const trend = s.sales.revenueDelta == null ? '' : ` (${s.sales.revenueDelta >= 0 ? '+' : ''}${s.sales.revenueDelta}% vs prior period)`;
  return {
    summary: `${s.sales.orders} orders and ${s.sales.revenue.toLocaleString()} revenue${trend}; ${s.crm.openDeals} open deals, ${s.finance.outstanding.toLocaleString()} outstanding, ${s.support.openTickets} open tickets.`,
    recommendations,
    risks: risks.length ? risks : ['No material risks detected this period.'],
    opportunities: opportunities.length ? opportunities : ['Keep engaging existing customers to grow repeat revenue.'],
    byArea: {
      sales: `${s.sales.orders} orders, ${s.sales.revenue.toLocaleString()} revenue, avg order ${s.sales.avgOrderValue.toLocaleString()}.`,
      customers: `${s.customers.total} total customers, ${s.customers.newInPeriod} new this period.`,
      crm: `${s.crm.openDeals} open deals (${s.crm.pipelineValue.toLocaleString()}); won ${s.crm.wonCount}, lost ${s.crm.lostCount}, ${s.crm.newLeads} new leads.`,
      inventory: `${s.inventory.lowStock} low-stock, ${s.inventory.outOfStock} out-of-stock variants.`,
      finance: `${s.finance.outstanding.toLocaleString()} outstanding, ${s.finance.overdue.toLocaleString()} overdue across ${s.finance.overdueCount} invoices.`,
      support: `${s.support.openTickets} open tickets, ${s.support.resolvedInPeriod} resolved this period.`,
      marketing: `${s.marketing.campaignsSent} campaigns, ${s.marketing.messagesSent} sent, ${s.marketing.opened} opened, ${s.marketing.clicked} clicked.`,
    },
  };
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}
