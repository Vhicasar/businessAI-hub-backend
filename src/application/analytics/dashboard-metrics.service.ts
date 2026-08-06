import { Prisma } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

const DAY = 86_400_000;

/** LeadStatus in funnel order. Must match the Prisma enum exactly. */
const PIPELINE_STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'UNQUALIFIED',
  'LOST',
] as const;

/** Always drawn, even at zero, so a new workspace still sees the shape. */
const CORE_STAGES: readonly string[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED'];
const ZERO = new Prisma.Decimal(0);

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new AppError('NO_TENANT', 403, 'Organization context required');
  return id;
}

const num = (d: Prisma.Decimal | null | undefined) => Number(d ?? ZERO);

/**
 * Bucket rows into a dated series, oldest first.
 *
 * Every series on the dashboard is built the same way so charts line up on the
 * X axis — a revenue point and an orders point for "12 March" must be the same
 * bucket, or the two charts tell different stories about the same day.
 */
function series<T>(
  rows: T[],
  from: Date,
  to: Date,
  bucketMs: number,
  dateOf: (row: T) => Date | null | undefined,
  fields: Record<string, (row: T) => number>
): Record<string, number | string>[] {
  const keys = Object.keys(fields);
  const buckets: Record<string, number | string>[] = [];

  for (let t = from.getTime(); t < to.getTime(); t += bucketMs) {
    const point: Record<string, number | string> = {
      date: new Date(t).toISOString().slice(0, 10),
    };
    for (const key of keys) point[key] = 0;
    buckets.push(point);
  }
  if (buckets.length === 0) {
    const point: Record<string, number | string> = { date: from.toISOString().slice(0, 10) };
    for (const key of keys) point[key] = 0;
    buckets.push(point);
  }

  for (const row of rows) {
    const at = dateOf(row);
    if (!at) continue;
    const idx = Math.floor((at.getTime() - from.getTime()) / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    for (const key of keys) {
      buckets[idx]![key] = (buckets[idx]![key] as number) + fields[key]!(row);
    }
  }
  return buckets;
}

/** Percent change, or null when there is no baseline to compare against. */
const pct = (current: number, previous: number): number | null =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

/**
 * Everything the business dashboard shows, in one request.
 *
 * Gathered here rather than as a dozen endpoints because the dashboard needs
 * all of it at once and a dozen round-trips would render the page in stages.
 * Each section is independent, so a module a business does not use simply
 * returns zeros instead of failing the whole dashboard.
 */
/**
 * Which dashboard sections apply to a business, decided by what it *is* rather
 * than by whether a stray record happens to exist.
 *
 * A supermarket with one property row on file is still not a property business,
 * and showing it an occupancy gauge is noise. Deciding here rather than in the
 * client means every surface — web, mobile, anything later — agrees.
 */
function modulesFor(businessType: string) {
  const isRealEstate = businessType === 'REAL_ESTATE';
  return {
    realEstate: isRealEstate,
    // Deliberately not the strict mirror: a property business that genuinely
    // lists products should still see them, whereas hiding a catalogue a
    // business actually uses would lose real information.
    catalogue: !isRealEstate,
  };
}

/** Shapes a failed section falls back to, so the client never sees a null. */
const EMPTY = {
  customers: {
    total: 0, new: 0, newChangePct: null as number | null, returning: 0, repeatRatePct: 0,
    linkedToVhicasarId: 0,
    growth: [] as Record<string, number | string>[],
    top: [] as { id: string; name: string; lifetimeValue: number; orders: number }[],
  },
  commerce: {
    revenue: 0, revenueChangePct: null as number | null, orders: 0,
    ordersChangePct: null as number | null, averageOrderValue: 0, outstanding: 0,
    trend: [] as Record<string, number | string>[],
    byStatus: [] as { status: string; count: number }[],
    paymentMix: [] as { method: string; count: number; amount: number }[],
    receivablesAgeing: [] as { bucket: string; amount: number }[],
    topProducts: [] as { name: string; quantity: number; revenue: number }[],
  },
  catalogue: {
    products: 0, categories: 0,
    byStatus: [] as { status: string; count: number }[],
    stock: { trackedVariants: 0, unitsOnHand: 0, health: [] as { state: string; count: number }[] },
  },
  realestate: {
    properties: 0, available: 0, occupancyPct: 0, activeLeases: 0, portfolioValue: 0,
    byStatus: [] as { status: string; count: number }[],
    byType: [] as { type: string; count: number }[],
  },
  operations: {
    openConversations: 0, unassignedConversations: 0, openTickets: 0,
    ticketsByStatus: [] as { status: string; count: number }[],
    appointments: 0, upcomingAppointments: 0,
    appointmentSeries: [] as Record<string, number | string>[],
    leads: 0,
    leadSeries: [] as Record<string, number | string>[],
    pipeline: [] as { stage: string; count: number }[],
  },
  people: { staff: 0, branches: 0, activeToday: 0 },
};

export const dashboardMetrics = {
  async build(opts: { from: Date; to: Date }) {
    const organizationId = orgId();
    const { from, to } = opts;
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY));
    const prevFrom = new Date(from.getTime() - days * DAY);

    // Weekly buckets past a quarter, so a year-long range doesn't render 365
    // unreadable columns.
    const bucketMs = (days > 92 ? 7 : 1) * DAY;

    const org = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true, businessType: true },
    });

    const modules = modulesFor(org.businessType);

    // Each section is wrapped so a module a business does not use — or one
    // slow query — degrades to zeros instead of blanking the whole dashboard.
    // Sections that do not apply are not queried at all: no work, and no data
    // for a client to render by mistake.
    const [customers, commerce, catalogue, realestate, operations, people] = await Promise.all([
      safeSection('customers', () => this.customers(from, to, prevFrom, bucketMs), EMPTY.customers),
      safeSection('commerce', () => this.commerce(from, to, prevFrom, bucketMs), EMPTY.commerce),
      modules.catalogue
        ? safeSection('catalogue', () => this.catalogue(), EMPTY.catalogue)
        : EMPTY.catalogue,
      modules.realEstate
        ? safeSection('realestate', () => this.realestate(), EMPTY.realestate)
        : EMPTY.realestate,
      safeSection('operations', () => this.operations(from, to, bucketMs), EMPTY.operations),
      safeSection('people', () => this.people(), EMPTY.people),
    ]);

    return {
      currency: org.currency,
      businessType: org.businessType,
      /** Which sections the client should render for this business. */
      modules,
      range: { from: from.toISOString(), to: to.toISOString(), days },
      customers,
      commerce,
      catalogue,
      realestate,
      operations,
      people,
    };
  },

  /** Who the customers are and how the base is growing. */
  async customers(from: Date, to: Date, prevFrom: Date, bucketMs: number) {
    const [total, newRows, newPrev, returning, topRows, linked] = await Promise.all([
      prisma.customer.count({ where: { deletedAt: null } }),
      prisma.customer.findMany({
        where: { deletedAt: null, createdAt: { gte: from, lte: to } },
        select: { createdAt: true },
      }),
      prisma.customer.count({ where: { deletedAt: null, createdAt: { gte: prevFrom, lt: from } } }),
      // "Returning" is a customer with more than one order — the only
      // definition that survives contact with a real order table.
      prisma.customer.count({ where: { deletedAt: null, totalOrders: { gt: 1 } } }),
      prisma.customer.findMany({
        where: { deletedAt: null, lifetimeValue: { gt: 0 } },
        orderBy: { lifetimeValue: 'desc' },
        take: 8,
        select: { id: true, firstName: true, lastName: true, lifetimeValue: true, totalOrders: true },
      }),
      // How many of this org's customers carry a Vhicasar ID.
      prismaUnscoped.customerLink.count({
        where: { organizationId: orgId(), status: 'ACTIVE' },
      }),
    ]);

    return {
      total,
      new: newRows.length,
      newChangePct: pct(newRows.length, newPrev),
      returning,
      /** Share of the base that has bought more than once. */
      repeatRatePct: total > 0 ? Math.round((returning / total) * 1000) / 10 : 0,
      linkedToVhicasarId: linked,
      growth: series(newRows, from, to, bucketMs, (c) => c.createdAt, { customers: () => 1 }),
      top: topRows.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed',
        lifetimeValue: num(c.lifetimeValue),
        orders: c.totalOrders,
      })),
    };
  },

  /** Orders, revenue, payment mix and what is still owed. */
  async commerce(from: Date, to: Date, prevFrom: Date, bucketMs: number) {
    const [orders, ordersPrev, byStatus, payments, paymentsPrev, invoices, topItems] =
      await Promise.all([
        prisma.order.findMany({
          where: { createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
          select: { createdAt: true, total: true },
        }),
        prisma.order.count({
          where: { createdAt: { gte: prevFrom, lt: from }, status: { not: 'CANCELLED' } },
        }),
        prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.payment.findMany({
          where: { status: 'PAID', paidAt: { gte: from, lte: to } },
          select: { paidAt: true, amount: true, method: true },
        }),
        prisma.payment.aggregate({
          where: { status: 'PAID', paidAt: { gte: prevFrom, lt: from } },
          _sum: { amount: true },
        }),
        prisma.invoice.findMany({
          where: { status: { notIn: ['PAID', 'VOID'] } },
          select: { total: true, amountPaid: true, dueAt: true },
        }),
        // OrderItem carries no organizationId, so the tenant extension cannot
        // scope it — the filter has to name the org through the parent order
        // explicitly, or this leaks another business's best sellers.
        prisma.orderItem.groupBy({
          by: ['name'],
          where: {
            order: {
              organizationId: orgId(),
              createdAt: { gte: from, lte: to },
              status: { not: 'CANCELLED' },
            },
          },
          _sum: { quantity: true, total: true },
          orderBy: { _sum: { total: 'desc' } },
          take: 8,
        }),
      ]);

    const revenue = payments.reduce((sum, p) => sum + num(p.amount), 0);
    const revenuePrev = num(paymentsPrev._sum.amount);

    // Receivables ageing: what is overdue, and by how long. This is the figure
    // that decides whether a business chases someone today.
    const now = Date.now();
    const ageing = { current: 0, due30: 0, due60: 0, due90: 0, over90: 0 };
    let outstanding = 0;
    for (const inv of invoices) {
      const owed = num(inv.total) - num(inv.amountPaid);
      if (owed <= 0) continue;
      outstanding += owed;
      if (!inv.dueAt || inv.dueAt.getTime() >= now) {
        ageing.current += owed;
        continue;
      }
      const overdueDays = Math.floor((now - inv.dueAt.getTime()) / DAY);
      if (overdueDays <= 30) ageing.due30 += owed;
      else if (overdueDays <= 60) ageing.due60 += owed;
      else if (overdueDays <= 90) ageing.due90 += owed;
      else ageing.over90 += owed;
    }

    const methodTotals = new Map<string, { count: number; amount: number }>();
    for (const p of payments) {
      const entry = methodTotals.get(p.method) ?? { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += num(p.amount);
      methodTotals.set(p.method, entry);
    }

    // Revenue and order volume share one series so the two can be overlaid —
    // seeing volume rise while revenue falls is the whole point.
    const revenueSeries = series(payments, from, to, bucketMs, (p) => p.paidAt, {
      revenue: (p) => num(p.amount),
    });
    const orderSeries = series(orders, from, to, bucketMs, (o) => o.createdAt, {
      orders: () => 1,
      orderValue: (o) => num(o.total),
    });
    const trend = revenueSeries.map((point, i) => ({
      ...point,
      orders: (orderSeries[i]?.orders as number) ?? 0,
      orderValue: (orderSeries[i]?.orderValue as number) ?? 0,
    }));

    const orderValue = orders.reduce((sum, o) => sum + num(o.total), 0);

    return {
      revenue,
      revenueChangePct: pct(revenue, revenuePrev),
      orders: orders.length,
      ordersChangePct: pct(orders.length, ordersPrev),
      averageOrderValue: orders.length > 0 ? Math.round((orderValue / orders.length) * 100) / 100 : 0,
      outstanding,
      trend,
      byStatus: byStatus
        .map((s) => ({ status: s.status, count: s._count._all }))
        .sort((a, b) => b.count - a.count),
      paymentMix: [...methodTotals.entries()]
        .map(([method, v]) => ({ method, count: v.count, amount: v.amount }))
        .sort((a, b) => b.amount - a.amount),
      receivablesAgeing: [
        { bucket: 'Not due', amount: ageing.current },
        { bucket: '1–30 days', amount: ageing.due30 },
        { bucket: '31–60 days', amount: ageing.due60 },
        { bucket: '61–90 days', amount: ageing.due90 },
        { bucket: '90+ days', amount: ageing.over90 },
      ],
      topProducts: topItems.map((i) => ({
        name: i.name,
        quantity: num(i._sum.quantity),
        revenue: num(i._sum.total),
      })),
    };
  },

  /** What the business sells, and whether it can keep selling it. */
  async catalogue() {
    const [total, byStatus, categories, stock] = await Promise.all([
      prisma.product.count({ where: { deletedAt: null } }),
      prisma.product.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.productCategory.count(),
      prisma.stockLevel
        .findMany({ select: { quantity: true, reserved: true, reorderPoint: true } })
        .catch(() => []),
    ]);

    // Stock health, because "how many products" says nothing about whether any
    // of them can actually be shipped.
    let inStock = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let unitsOnHand = 0;
    for (const level of stock) {
      const available = num(level.quantity) - num(level.reserved);
      unitsOnHand += num(level.quantity);
      const reorder = level.reorderPoint === null ? 0 : num(level.reorderPoint);
      if (available <= 0) outOfStock += 1;
      else if (reorder > 0 && available <= reorder) lowStock += 1;
      else inStock += 1;
    }

    return {
      products: total,
      categories,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      stock: {
        trackedVariants: stock.length,
        unitsOnHand,
        health: [
          { state: 'In stock', count: inStock },
          { state: 'Low stock', count: lowStock },
          { state: 'Out of stock', count: outOfStock },
        ],
      },
    };
  },

  /** Property portfolio, for businesses that have one. */
  async realestate() {
    const [total, byStatus, byType, activeLeases, value] = await Promise.all([
      prisma.property.count({ where: { deletedAt: null } }),
      prisma.property.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.property.groupBy({ by: ['type'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.lease.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
      prisma.property.aggregate({ where: { deletedAt: null }, _sum: { price: true } }),
    ]);

    const available = byStatus.find((s) => s.status === 'AVAILABLE')?._count._all ?? 0;

    return {
      properties: total,
      available,
      /** Share of the portfolio not sitting empty. */
      occupancyPct: total > 0 ? Math.round(((total - available) / total) * 1000) / 10 : 0,
      activeLeases,
      portfolioValue: num(value._sum.price),
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      byType: byType.map((t) => ({ type: t.type, count: t._count._all })),
    };
  },

  /** The day-to-day: conversations, bookings, tickets and the sales pipeline. */
  async operations(from: Date, to: Date, bucketMs: number) {
    const [openConversations, unassigned, meetings, tickets, ticketsByStatus, leads, leadsByStatus] =
      await Promise.all([
        prisma.conversation.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
        prisma.conversation.count({
          where: { status: { in: ['OPEN', 'PENDING'] }, assignedToId: null },
        }),
        prisma.meeting.findMany({
          where: { startAt: { gte: from, lte: to } },
          select: { startAt: true, status: true },
        }),
        prisma.ticket.count({ where: { deletedAt: null, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
        prisma.ticket.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
        prisma.lead.findMany({
          where: { deletedAt: null, createdAt: { gte: from, lte: to } },
          select: { createdAt: true },
        }),
        prisma.lead.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      ]);

    const upcoming = meetings.filter((m) => m.startAt.getTime() >= Date.now()).length;

    return {
      openConversations,
      unassignedConversations: unassigned,
      openTickets: tickets,
      ticketsByStatus: ticketsByStatus.map((t) => ({ status: t.status, count: t._count._all })),
      appointments: meetings.length,
      upcomingAppointments: upcoming,
      appointmentSeries: series(meetings, from, to, bucketMs, (m) => m.startAt, {
        appointments: () => 1,
      }),
      leads: leads.length,
      leadSeries: series(leads, from, to, bucketMs, (l) => l.createdAt, { leads: () => 1 }),
      // The real LeadStatus values, ordered as a funnel rather than
      // alphabetically so the chart reads the way a pipeline actually flows.
      // The two exits (UNQUALIFIED, LOST) come last because they are outcomes,
      // not stages a lead passes through.
      pipeline: PIPELINE_STAGES.map((stage) => ({
        stage,
        count: leadsByStatus.find((l) => l.status === stage)?._count._all ?? 0,
      })).filter((s) => s.count > 0 || CORE_STAGES.includes(s.stage)),
    };
  },

  /** The team behind all of it. */
  async people() {
    const [staff, branches, activeToday] = await Promise.all([
      prisma.membership.count({ where: { isActive: true, deletedAt: null } }),
      prisma.branch.count({ where: { isActive: true, deletedAt: null } }),
      prismaUnscoped.auditLog
        .findMany({
          where: {
            organizationId: orgId(),
            createdAt: { gte: new Date(Date.now() - DAY) },
            actorUserId: { not: null },
          },
          select: { actorUserId: true },
          distinct: ['actorUserId'],
        })
        .catch(() => []),
    ]);

    return { staff, branches, activeToday: activeToday.length };
  },
};

/**
 * Run one dashboard section, falling back to an empty shape on failure.
 *
 * A dashboard that renders five of six panels is useful; one that shows an
 * error because a business has no property module is not.
 */
async function safeSection<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err, section: label }, 'dashboard section failed; returning empty');
    return fallback;
  }
}
