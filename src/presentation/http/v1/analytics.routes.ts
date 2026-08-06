import { Router, type Request, type RequestHandler, type Response } from 'express';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { prisma } from '../../../infrastructure/database/prisma';
import { analyticsService } from '../../../application/analytics/analytics.service';
import { productIntelligenceService } from '../../../application/analytics/product-intelligence.service';
import { aiInsightsService } from '../../../application/analytics/ai-insights.service';
import { requestContext } from '../../../shared/context';
import { exchangeRates } from '../../../shared/exchange-rates';
import { resolveDateRange, previousRange } from '../../../shared/date-range';
import { dashboardMetrics } from '../../../application/analytics/dashboard-metrics.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const DAY = 24 * 60 * 60 * 1000;

export const analyticsRoutes = Router();
analyticsRoutes.use(authenticate, requireTenant);

/** CRM analytics: pipeline, forecast, lead funnel, sources, salesperson performance. */
analyticsRoutes.get(
  '/crm',
  requirePermission('analytics.view', 'crm.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await analyticsService.crmDashboard(resolveDateRange(req.query)) });
  })
);

/** Support analytics: volume, response/resolution times, SLA, CSAT/NPS/CES, agents. */
analyticsRoutes.get(
  '/support',
  requirePermission('analytics.view', 'support.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await analyticsService.supportDashboard(resolveDateRange(req.query)) });
  })
);

/** AI Insights: org-wide business intelligence + AI recommendations/risks/opportunities. */
analyticsRoutes.get(
  '/ai-insights',
  requirePermission('analytics.view', 'dashboard.view'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiInsightsService.dashboard(resolveDateRange(req.query)) });
  })
);

/** Product Intelligence: per-product sales / customer / behaviour / inventory dashboard. */
analyticsRoutes.get(
  '/products/:id',
  requirePermission('analytics.view', 'catalog.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productIntelligenceService.productDashboard(req.params.id as string, resolveDateRange(req.query)),
    });
  })
);

/** AI-generated insights for a product (demand, restocking, pricing, health). */
analyticsRoutes.get(
  '/products/:id/insights',
  requirePermission('analytics.view', 'catalog.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productIntelligenceService.productInsights(req.params.id as string, resolveDateRange(req.query)),
    });
  })
);

/**
 * Dashboard overview: KPIs over the selected date range + a revenue trend, with
 * period-over-period deltas against the equal-length previous window. Field
 * names keep the `30` suffix for backwards compatibility with existing clients.
 */
/**
 * Everything the business dashboard renders, in one request.
 *
 * Separate from `/overview`, which existing clients still depend on: this is
 * additive, so nothing that reads the old shape has to change.
 */
analyticsRoutes.get(
  '/dashboard',
  requirePermission('dashboard.view', 'analytics.view'),
  wrap(async (req, res) => {
    const range = resolveDateRange(req.query);
    const data = await dashboardMetrics.build({ from: range.from, to: range.to });
    res.json({ success: true, data: { ...data, range: { ...data.range, preset: range.preset } } });
  })
);

analyticsRoutes.get(
  '/overview',
  requirePermission('dashboard.view', 'analytics.view'),
  wrap(async (req, res) => {
    const range = resolveDateRange(req.query);
    const prev = previousRange(range);
    const { from, to } = range;

    const [
      paymentsCur,
      paymentsPrev,
      ordersCur,
      ordersPrev,
      openConversations,
      leadsCur,
      trendPayments,
    ] = await Promise.all([
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: from, lte: to } },
        select: { amount: true, currency: true },
      }),
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: prev.from, lt: prev.to } },
        select: { amount: true, currency: true },
      }),
      prisma.order.count({ where: { createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } } }),
      prisma.order.count({
        where: { createdAt: { gte: prev.from, lt: prev.to }, status: { not: 'CANCELLED' } },
      }),
      prisma.conversation.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
      prisma.lead.count({ where: { createdAt: { gte: from, lte: to }, deletedAt: null } }),
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: from, lte: to } },
        select: { amount: true, currency: true, paidAt: true },
      }),
    ]);
    const organizationId = requestContext.get()?.organizationId;
    if (!organizationId) throw new Error('No tenant in request context');
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });
    const convertedCur = await Promise.all(paymentsCur.map(
      (p) => exchangeRates.convert(Number(p.amount), p.currency, org.currency),
    ));
    const convertedPrev = await Promise.all(paymentsPrev.map(
      (p) => exchangeRates.convert(Number(p.amount), p.currency, org.currency),
    ));
    const convertedTrend = await Promise.all(trendPayments.map(async (p) => ({
      paidAt: p.paidAt,
      amount: (await exchangeRates.convert(Number(p.amount), p.currency, org.currency)).amount,
    })));

    // Bucket the window (daily, or weekly for long ranges) oldest → newest.
    const bucketMs = (range.days > 92 ? 7 : 1) * DAY;
    const trend: { date: string; revenue: number }[] = [];
    for (let t = from.getTime(); t < to.getTime(); t += bucketMs) {
      trend.push({ date: new Date(t).toISOString().slice(0, 10), revenue: 0 });
    }
    if (trend.length === 0) trend.push({ date: from.toISOString().slice(0, 10), revenue: 0 });
    for (const p of convertedTrend) {
      if (!p.paidAt) continue;
      const idx = Math.floor((p.paidAt.getTime() - from.getTime()) / bucketMs);
      if (idx >= 0 && idx < trend.length) trend[idx]!.revenue += p.amount;
    }

    const revenueCur = convertedCur.reduce((sum, p) => sum + p.amount, 0);
    const revenuePrev = convertedPrev.reduce((sum, p) => sum + p.amount, 0);
    const pct = (curr: number, previous: number): number | null =>
      previous > 0 ? Math.round(((curr - previous) / previous) * 1000) / 10 : null;

    res.json({
      success: true,
      data: {
        revenue30: revenueCur,
        currency: org.currency,
        revenueChangePct: pct(revenueCur, revenuePrev),
        orders30: ordersCur,
        ordersChangePct: pct(ordersCur, ordersPrev),
        openConversations,
        leads30: leadsCur,
        trend,
        range: { from: from.toISOString(), to: to.toISOString(), days: range.days, preset: range.preset },
      },
    });
  })
);
