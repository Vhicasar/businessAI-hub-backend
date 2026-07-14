import { Router, type Request, type RequestHandler, type Response } from 'express';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { prisma } from '../../../infrastructure/database/prisma';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const DAY = 24 * 60 * 60 * 1000;

export const analyticsRoutes = Router();
analyticsRoutes.use(authenticate, requireTenant);

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
      prisma.payment.aggregate({
        where: { status: 'PAID', paidAt: { gte: since30 } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { status: 'PAID', paidAt: { gte: prev30, lt: since30 } },
        _sum: { amount: true },
      }),
      prisma.order.count({ where: { createdAt: { gte: since30 }, status: { not: 'CANCELLED' } } }),
      prisma.order.count({
        where: { createdAt: { gte: prev30, lt: since30 }, status: { not: 'CANCELLED' } },
      }),
      prisma.conversation.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
      prisma.lead.count({ where: { createdAt: { gte: since30 }, deletedAt: null } }),
      prisma.payment.findMany({
        where: { status: 'PAID', paidAt: { gte: since14 } },
        select: { amount: true, paidAt: true },
      }),
    ]);

    // Bucket the last 14 days (oldest → newest).
    const trend: { date: string; revenue: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * DAY);
      trend.push({ date: day.toISOString().slice(0, 10), revenue: 0 });
    }
    const byDate = new Map(trend.map((t) => [t.date, t]));
    for (const p of trendPayments) {
      const key = p.paidAt?.toISOString().slice(0, 10);
      const bucket = key ? byDate.get(key) : undefined;
      if (bucket) bucket.revenue += Number(p.amount);
    }

    const revenue30 = Number(payments30._sum.amount ?? 0);
    const revenuePrev = Number(paymentsPrev._sum.amount ?? 0);
    const pct = (curr: number, prev: number): number | null =>
      prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null;

    res.json({
      success: true,
      data: {
        revenue30,
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
