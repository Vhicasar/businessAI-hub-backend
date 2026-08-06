import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';

/**
 * Customer Super App — the universal consumer profile that spans every business
 * a Vhicasar ID is linked to (Flutter Bible §15). Reads per-org data through the
 * UNSCOPED client, always filtered to the caller's OWN linked customer records
 * (resolved from CustomerLink), so cross-tenant reach is limited to this
 * consumer's own footprint and never leaks other customers' data.
 */

interface LinkedCustomer {
  customerId: string;
  organizationId: string;
  orgName: string;
}

async function linkedCustomers(vhicasarId: string): Promise<LinkedCustomer[]> {
  const links = await prismaUnscoped.customerLink.findMany({
    where: { vhicasarId, status: 'ACTIVE' },
    select: { customerId: true, organizationId: true, organization: { select: { name: true } } },
  });
  return links.map((l) => ({
    customerId: l.customerId,
    organizationId: l.organizationId,
    orgName: l.organization.name,
  }));
}

export const superAppService = {
  /** Universal loyalty: every linked business's points balance in one list. */
  async loyalty(vhicasarId: string) {
    const links = await linkedCustomers(vhicasarId);
    if (links.length === 0) return { totalPoints: 0, accounts: [] };
    const customerIds = links.map((l) => l.customerId);
    const orgOf = new Map(links.map((l) => [l.customerId, l]));

    const accounts = await prismaUnscoped.loyaltyAccount.findMany({
      where: { customerId: { in: customerIds } },
      select: {
        balance: true,
        tier: true,
        customerId: true,
        program: { select: { name: true, redeemRate: true } },
      },
    });

    return {
      totalPoints: accounts.reduce((sum, a) => sum + a.balance, 0),
      accounts: accounts.map((a) => ({
        business: orgOf.get(a.customerId)?.orgName ?? '—',
        program: a.program.name,
        points: a.balance,
        tier: a.tier,
        redeemValue: (a.balance * Number(a.program.redeemRate)).toFixed(2),
      })),
    };
  },

  /** Recent orders across every linked business. */
  async orders(vhicasarId: string, opts: { cursor?: string; limit: number }) {
    const links = await linkedCustomers(vhicasarId);
    if (links.length === 0) return { items: [], nextCursor: null };
    const customerIds = links.map((l) => l.customerId);
    const orgOf = new Map(links.map((l) => [l.customerId, l.orgName]));

    const rows = await prismaUnscoped.order.findMany({
      where: { customerId: { in: customerIds } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true, number: true, status: true, paymentStatus: true,
        total: true, currency: true, createdAt: true, customerId: true,
      },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((o) => ({
        id: o.id,
        number: o.number,
        business: orgOf.get(o.customerId) ?? '—',
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: o.total.toFixed(2),
        currency: o.currency,
        createdAt: o.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /** Unified customer timeline across businesses (Strategic Differentiator). */
  async timeline(vhicasarId: string, opts: { cursor?: string; limit: number }) {
    const links = await linkedCustomers(vhicasarId);
    if (links.length === 0) return { items: [], nextCursor: null };
    const customerIds = links.map((l) => l.customerId);
    const orgByCustomer = new Map(links.map((l) => [l.customerId, l.orgName]));

    const rows = await prismaUnscoped.activity.findMany({
      where: { entityType: 'CUSTOMER', entityId: { in: customerIds } },
      orderBy: { occurredAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: { id: true, type: true, title: true, body: true, occurredAt: true, entityId: true },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((a) => ({
        id: a.id,
        type: a.type,
        business: orgByCustomer.get(a.entityId) ?? '—',
        title: a.title,
        body: a.body,
        occurredAt: a.occurredAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /** Home-screen summary: businesses, points, spend, order count. */
  async overview(vhicasarId: string) {
    const links = await linkedCustomers(vhicasarId);
    const customerIds = links.map((l) => l.customerId);

    const [pointsAgg, orderAgg] = customerIds.length
      ? await Promise.all([
          prismaUnscoped.loyaltyAccount.aggregate({
            where: { customerId: { in: customerIds } },
            _sum: { balance: true },
          }),
          prismaUnscoped.order.aggregate({
            where: { customerId: { in: customerIds } },
            _count: { _all: true },
            _sum: { total: true },
          }),
        ])
      : [{ _sum: { balance: null } }, { _count: { _all: 0 }, _sum: { total: null } }];

    return {
      businesses: links.length,
      loyaltyPoints: pointsAgg._sum.balance ?? 0,
      orders: orderAgg._count._all,
      totalSpend: (orderAgg._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
    };
  },
};
