import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { exchangeRates } from '../../shared/exchange-rates';
import type { DateRange } from '../../shared/date-range';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * CRM analytics & forecasting. Everything is tenant-scoped via the Prisma
 * extension, so no organizationId filters are needed here.
 */
export const analyticsService = {
  async crmDashboard(range: DateRange) {
    const since = range.from;
    const until = range.to;
    const organizationId = requestContext.get()?.organizationId;
    if (!organizationId) throw new Error('No tenant in request context');
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });

    const [openDeals, wonDeals, lostDeals, leadsByStatus, leadsCreated, leadsConverted, bySource, members] =
      await Promise.all([
        prisma.deal.findMany({
          where: { deletedAt: null, status: 'OPEN' },
          select: {
            value: true,
            currency: true,
            ownerId: true,
            stage: { select: { name: true, position: true, probability: true } },
          },
        }),
        prisma.deal.findMany({
          where: { deletedAt: null, status: 'WON', closedAt: { gte: since, lte: until } },
          select: { value: true, currency: true, ownerId: true },
        }),
        prisma.deal.count({ where: { deletedAt: null, status: 'LOST', closedAt: { gte: since, lte: until } } }),
        prisma.lead.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
        prisma.lead.count({ where: { deletedAt: null, createdAt: { gte: since, lte: until } } }),
        prisma.lead.count({ where: { status: 'CONVERTED', convertedAt: { gte: since, lte: until } } }),
        prisma.lead.groupBy({
          by: ['source'],
          where: { deletedAt: null, createdAt: { gte: since, lte: until } },
          _count: { _all: true },
        }),
        prisma.membership.findMany({
          where: { deletedAt: null },
          select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } },
        }),
      ]);
    const convertedOpenDeals = await Promise.all(openDeals.map(async (deal) => ({
      ...deal,
      value: (await exchangeRates.convert(Number(deal.value), deal.currency, org.currency)).amount,
    })));
    const convertedWonDeals = await Promise.all(wonDeals.map(async (deal) => ({
      ...deal,
      value: (await exchangeRates.convert(Number(deal.value), deal.currency, org.currency)).amount,
    })));

    // ---- pipeline by stage + weighted forecast
    const stageMap = new Map<string, { name: string; position: number; count: number; value: number; weighted: number }>();
    let totalOpenValue = 0;
    let weightedForecast = 0;
    for (const d of convertedOpenDeals) {
      const v = Number(d.value);
      totalOpenValue = round2(totalOpenValue + v);
      const w = round2((v * d.stage.probability) / 100);
      weightedForecast = round2(weightedForecast + w);
      const key = `${d.stage.position}:${d.stage.name}`;
      const cur = stageMap.get(key) ?? { name: d.stage.name, position: d.stage.position, count: 0, value: 0, weighted: 0 };
      cur.count += 1;
      cur.value = round2(cur.value + v);
      cur.weighted = round2(cur.weighted + w);
      stageMap.set(key, cur);
    }
    const stages = [...stageMap.values()].sort((a, b) => a.position - b.position);

    // ---- deal outcomes
    const wonValue = round2(convertedWonDeals.reduce((s, d) => s + Number(d.value), 0));
    const wonCount = convertedWonDeals.length;
    const winRate = wonCount + lostDeals > 0 ? round2((wonCount / (wonCount + lostDeals)) * 100) : 0;

    // ---- lead funnel + conversion
    const byStatus: Record<string, number> = {};
    for (const r of leadsByStatus) byStatus[r.status] = r._count._all;
    const conversionRate = leadsCreated > 0 ? round2((leadsConverted / leadsCreated) * 100) : 0;

    // ---- source performance
    const sources = bySource
      .map((s) => ({ source: s.source ?? 'Unknown', count: s._count._all }))
      .sort((a, b) => b.count - a.count);

    // ---- salesperson performance
    const nameOf = (id: string | null) => {
      if (!id) return 'Unassigned';
      const m = members.find((x) => x.id === id);
      return m ? `${m.user.firstName} ${m.user.lastName ?? ''}`.trim() || m.user.email : 'Unknown';
    };
    const ownerMap = new Map<string, { name: string; openDeals: number; openValue: number; wonDeals: number }>();
    const ownerRow = (id: string | null) => {
      const key = id ?? 'none';
      const row = ownerMap.get(key) ?? { name: nameOf(id), openDeals: 0, openValue: 0, wonDeals: 0 };
      ownerMap.set(key, row);
      return row;
    };
    for (const d of convertedOpenDeals) {
      const row = ownerRow(d.ownerId);
      row.openDeals += 1;
      row.openValue = round2(row.openValue + Number(d.value));
    }
    for (const d of convertedWonDeals) ownerRow(d.ownerId).wonDeals += 1;
    const owners = [...ownerMap.values()].sort((a, b) => b.openValue - a.openValue);

    return {
      period: { days: range.days, from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      currency: org.currency,
      pipeline: { stages, totalOpenValue, weightedForecast },
      deals: { openCount: convertedOpenDeals.length, wonCount, wonValue, lostCount: lostDeals, winRate },
      leads: {
        total: leadsByStatus.reduce((s, r) => s + r._count._all, 0),
        byStatus,
        createdInPeriod: leadsCreated,
        convertedInPeriod: leadsConverted,
        conversionRate,
      },
      sources,
      owners,
    };
  },

  // ------------------------------------------------------- support analytics
  async supportDashboard(range: DateRange) {
    const since = range.from;
    const until = range.to;

    const [tickets, members] = await Promise.all([
      prisma.ticket.findMany({
        where: { deletedAt: null, createdAt: { gte: since, lte: until } },
        select: {
          status: true, priority: true, assigneeId: true, createdAt: true,
          firstRespondedAt: true, firstResponseDueAt: true,
          resolvedAt: true, resolutionDueAt: true, escalatedAt: true,
          satisfactionScore: true, npsScore: true, cesScore: true,
        },
      }),
      prisma.membership.findMany({
        where: { deletedAt: null },
        select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } },
      }),
    ]);

    const total = tickets.length;
    const resolved = tickets.filter((t) => t.resolvedAt !== null);
    const open = tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status));
    const escalated = tickets.filter((t) => t.escalatedAt !== null);

    const mins = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
    const avg = (xs: number[]) => (xs.length ? round2(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

    const firstResponseTimes = tickets.filter((t) => t.firstRespondedAt).map((t) => mins(t.createdAt, t.firstRespondedAt!));
    const resolutionTimes = resolved.map((t) => mins(t.createdAt, t.resolvedAt!));

    // SLA compliance — met when the milestone happened before its due date.
    const frDue = tickets.filter((t) => t.firstRespondedAt && t.firstResponseDueAt);
    const frMet = frDue.filter((t) => t.firstRespondedAt! <= t.firstResponseDueAt!).length;
    const resDue = resolved.filter((t) => t.resolutionDueAt);
    const resMet = resDue.filter((t) => t.resolvedAt! <= t.resolutionDueAt!).length;
    const pct = (n: number, d: number) => (d > 0 ? round2((n / d) * 100) : 0);

    // Voice of customer
    const csat = tickets.map((t) => t.satisfactionScore).filter((x): x is number => x !== null);
    const nps = tickets.map((t) => t.npsScore).filter((x): x is number => x !== null);
    const ces = tickets.map((t) => t.cesScore).filter((x): x is number => x !== null);
    const promoters = nps.filter((n) => n >= 9).length;
    const detractors = nps.filter((n) => n <= 6).length;
    const npsScore = nps.length ? Math.round(((promoters - detractors) / nps.length) * 100) : 0;

    const byPriority: Record<string, number> = {};
    for (const t of tickets) byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    const byStatus: Record<string, number> = {};
    for (const t of tickets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

    // Agent performance
    const nameOf = (id: string | null) => {
      if (!id) return 'Unassigned';
      const m = members.find((x) => x.id === id);
      return m ? `${m.user.firstName} ${m.user.lastName ?? ''}`.trim() || m.user.email : 'Unknown';
    };
    const agentMap = new Map<string, { name: string; assigned: number; resolved: number; resTimes: number[]; csat: number[] }>();
    for (const t of tickets) {
      const key = t.assigneeId ?? 'none';
      const row = agentMap.get(key) ?? { name: nameOf(t.assigneeId), assigned: 0, resolved: 0, resTimes: [], csat: [] };
      row.assigned += 1;
      if (t.resolvedAt) {
        row.resolved += 1;
        row.resTimes.push(mins(t.createdAt, t.resolvedAt));
      }
      if (t.satisfactionScore !== null) row.csat.push(t.satisfactionScore);
      agentMap.set(key, row);
    }
    const agents = [...agentMap.values()]
      .map((a) => ({ name: a.name, assigned: a.assigned, resolved: a.resolved, avgResolutionMins: avg(a.resTimes), avgCsat: avg(a.csat) }))
      .sort((x, y) => y.assigned - x.assigned);

    return {
      period: { days: range.days, from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
      volume: { total, open: open.length, resolved: resolved.length, escalated: escalated.length },
      times: { avgFirstResponseMins: avg(firstResponseTimes), avgResolutionMins: avg(resolutionTimes) },
      sla: {
        firstResponseCompliance: pct(frMet, frDue.length),
        resolutionCompliance: pct(resMet, resDue.length),
        breached: tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status) && t.resolutionDueAt && t.resolutionDueAt < new Date()).length,
      },
      satisfaction: {
        csatAvg: avg(csat), csatCount: csat.length,
        nps: npsScore, npsCount: nps.length,
        cesAvg: avg(ces), cesCount: ces.length,
      },
      escalationRate: pct(escalated.length, total),
      resolutionRate: pct(resolved.length, total),
      byPriority,
      byStatus,
      agents,
    };
  },
};
