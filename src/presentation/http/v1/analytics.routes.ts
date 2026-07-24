import { Router, type Request, type RequestHandler, type Response } from 'express';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { prisma } from '../../../infrastructure/database/prisma';
import { analyticsService } from '../../../application/analytics/analytics.service';
import { requestContext } from '../../../shared/context';
import { exchangeRates } from '../../../shared/exchange-rates';

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
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json({ success: true, data: await analyticsService.crmDashboard(days) });
  })
);

/** Support analytics: volume, response/resolution times, SLA, CSAT/NPS/CES, agents. */
analyticsRoutes.get(
  '/support',
  requirePermission('analytics.view', 'support.read'),
  wrap(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json({ success: true, data: await analyticsService.supportDashboard(days) });
  })
);

/** Dashboard overview: 30-day KPIs + 14-day revenue trend. */
analyticsRoutes.get(
  '/overview',
  requirePermission('dashboard.view', 'analytics.view'),
  wrap(async (_req, res) => {
    const since30 = new Date(Date.now() - 30 * DAY);
    const prev30 = new Date(Date.now() - 60 * DAY);
    const since14 = new Date(Date.now() - 14 * DAY);

    const [
      payments30,
      paymentsPrev,
      orders30,
      ordersPrev,
      openConversations,
      leads30,
      trendPayments,
    ] = await Promise.all([
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: since30 } },
        select: { amount: true, currency: true },
      }),
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: prev30, lt: since30 } },
        select: { amount: true, currency: true },
      }),
      prisma.order.count({ where: { createdAt: { gte: since30 }, status: { not: 'CANCELLED' } } }),
      prisma.order.count({
        where: { createdAt: { gte: prev30, lt: since30 }, status: { not: 'CANCELLED' } },
      }),
      prisma.conversation.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
      prisma.lead.count({ where: { createdAt: { gte: since30 }, deletedAt: null } }),
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: since14 } },
        select: { amount: true, currency: true, paidAt: true },
      }),
    ]);
    const organizationId = requestContext.get()?.organizationId;
    if (!organizationId) throw new Error('No tenant in request context');
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });
    const converted30 = await Promise.all(payments30.map(
      (p) => exchangeRates.convert(Number(p.amount), p.currency, org.currency),
    ));
    const convertedPrev = await Promise.all(paymentsPrev.map(
      (p) => exchangeRates.convert(Number(p.amount), p.currency, org.currency),
    ));
    const convertedTrend = await Promise.all(trendPayments.map(async (p) => ({
      ...p,
      amount: (await exchangeRates.convert(Number(p.amount), p.currency, org.currency)).amount,
    })));

    // Bucket the last 14 days (oldest → newest).
    const trend: { date: string; revenue: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * DAY);
      trend.push({ date: day.toISOString().slice(0, 10), revenue: 0 });
    }
    const byDate = new Map(trend.map((t) => [t.date, t]));
    for (const p of convertedTrend) {
      const key = p.paidAt?.toISOString().slice(0, 10);
      const bucket = key ? byDate.get(key) : undefined;
      if (bucket) bucket.revenue += Number(p.amount);
    }

    const revenue30 = converted30.reduce((sum, p) => sum + p.amount, 0);
    const revenuePrev = convertedPrev.reduce((sum, p) => sum + p.amount, 0);
    const pct = (curr: number, prev: number): number | null =>
      prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null;

    res.json({
      success: true,
      data: {
        revenue30,
        currency: org.currency,
        revenueChangePct: pct(revenue30, revenuePrev),
        orders30,
        ordersChangePct: pct(orders30, ordersPrev),
        openConversations,
        leads30,
        trend,
      },
    });
  })
);
