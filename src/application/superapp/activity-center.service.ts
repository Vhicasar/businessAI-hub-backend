import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { businessDashboard } from '../discovery/business-dashboard.service';
import { walletBuckets } from '../payments/wallet-buckets.service';

/**
 * Customer Activity Center (§15) — the Super App's operating dashboard.
 *
 * Everything here aggregates across the businesses a customer belongs to, and
 * every query is anchored to their own `CustomerLink` rows. That is what keeps
 * a cross-business view from becoming a cross-tenant leak: we never read an
 * organisation's data except through a link that customer owns, and no
 * business ever sees another's slice.
 */

const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal | null | undefined) => (v ?? ZERO).toFixed(2);

/** The businesses a customer is actively linked to, with their customer ids. */
async function linkedBusinesses(vhicasarId: string) {
  return prismaUnscoped.customerLink.findMany({
    where: { vhicasarId, status: 'ACTIVE' },
    select: {
      organizationId: true,
      customerId: true,
      isPinned: true,
      isHidden: true,
      isFavourite: true,
      lastAccessedAt: true,
      unreadPromotions: true,
    },
  });
}

export interface TimelineEntry {
  id: string;
  kind: string;
  organizationId: string | null;
  businessName: string | null;
  businessLogoFileId: string | null;
  title: string;
  detail: string | null;
  status: string | null;
  amount: string | null;
  currency: string | null;
  /** Where tapping it should land, inside the right business context. */
  deeplink: string | null;
  at: Date;
}

export const activityCenter = {
  /**
   * The landing dashboard: money, loyalty, and what needs attention, summed
   * across every linked business (§15).
   */
  async dashboard(vhicasarId: string, currency = 'NGN') {
    const links = await linkedBusinesses(vhicasarId);
    const orgIds = links.map((l) => l.organizationId);
    const customerIds = links.map((l) => l.customerId);
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 864e5);

    const [
      wallet,
      rewards,
      loyaltyAccounts,
      activePromotions,
      openOrders,
      unpaidInvoices,
      upcomingBookings,
      unreadNotifications,
      recentDocuments,
    ] = await Promise.all([
      walletBuckets.breakdown(vhicasarId, currency),
      prismaUnscoped.rewardAccount.findUnique({
        where: { vhicasarId },
        select: { balance: true, tier: true },
      }),
      customerIds.length
        ? prismaUnscoped.loyaltyAccount.findMany({
            where: { customerId: { in: customerIds } },
            select: { balance: true, tier: true, customerId: true },
          })
        : [],
      orgIds.length
        ? prismaUnscoped.promotion.count({
            where: {
              organizationId: { in: orgIds },
              status: 'ACTIVE',
              startsAt: { lte: now },
              endsAt: { gte: now },
            },
          })
        : 0,
      customerIds.length
        ? prismaUnscoped.order.count({
            where: {
              customerId: { in: customerIds },
              status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] },
            },
          })
        : 0,
      customerIds.length
        ? prismaUnscoped.invoice.findMany({
            where: {
              customerId: { in: customerIds },
              status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
            },
            select: { total: true, amountPaid: true, currency: true },
          })
        : [],
      customerIds.length
        ? prismaUnscoped.meeting.count({
            where: { customerId: { in: customerIds }, startAt: { gte: now, lte: soon } },
          })
        : 0,
      prismaUnscoped.customerNotification.count({ where: { vhicasarId, readAt: null } }),
      prismaUnscoped.customerDocument.count({ where: { vhicasarId } }),
    ]);

    const outstanding = unpaidInvoices.reduce(
      (sum, i) => sum.plus(i.total.minus(i.amountPaid)),
      ZERO
    );

    return {
      wallet,
      rewards: rewards ? { balance: rewards.balance, tier: rewards.tier } : { balance: 0, tier: null },
      /** Business points are per-org; the headline is their sum. */
      loyaltyPoints: loyaltyAccounts.reduce((sum, a) => sum + a.balance, 0),
      businesses: {
        total: links.length,
        pinned: links.filter((l) => l.isPinned).length,
        hidden: links.filter((l) => l.isHidden).length,
      },
      activePromotions,
      activeOrders: openOrders,
      pendingPayments: {
        count: unpaidInvoices.length,
        total: money(outstanding),
        currency,
      },
      upcomingBookings,
      unreadNotifications,
      documents: recentDocuments,
    };
  },

  /**
   * One chronological stream of everything that happened, across every
   * business (§15). Built from records the customer already owns, so nothing
   * appears here that they couldn't open individually.
   */
  async timeline(
    vhicasarId: string,
    opts: { organizationId?: string; limit?: number; before?: Date } = {}
  ): Promise<{ items: TimelineEntry[] }> {
    const links = await linkedBusinesses(vhicasarId);
    const scoped = opts.organizationId
      ? links.filter((l) => l.organizationId === opts.organizationId)
      : links;
    if (scoped.length === 0) return { items: [] };

    const orgIds = scoped.map((l) => l.organizationId);
    const customerIds = scoped.map((l) => l.customerId);
    const limit = opts.limit ?? 40;
    const before = opts.before ?? new Date();

    const [orgs, payments, orders, meetings, loyalty, rewards, documents] = await Promise.all([
      prismaUnscoped.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true, logoFileId: true },
      }),
      prismaUnscoped.payment.findMany({
        where: { customerId: { in: customerIds }, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true, organizationId: true, amount: true, currency: true,
          method: true, status: true, createdAt: true, orderId: true,
        },
      }),
      prismaUnscoped.order.findMany({
        where: { customerId: { in: customerIds }, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true, organizationId: true, number: true, status: true,
          total: true, currency: true, createdAt: true,
        },
      }),
      prismaUnscoped.meeting.findMany({
        where: { customerId: { in: customerIds }, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, organizationId: true, title: true, status: true, startAt: true, createdAt: true },
      }),
      customerIds.length
        ? prismaUnscoped.loyaltyTransaction.findMany({
            where: { account: { customerId: { in: customerIds } }, createdAt: { lt: before } },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
              id: true, points: true, type: true, note: true, createdAt: true,
              account: { select: { customerId: true } },
            },
          })
        : [],
      prismaUnscoped.rewardGrant.findMany({
        where: { vhicasarId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true, organizationId: true, rewardAmount: true, currency: true,
          status: true, createdAt: true,
        },
      }),
      prismaUnscoped.customerDocument.findMany({
        where: { vhicasarId, ...(opts.organizationId ? { organizationId: opts.organizationId } : {}), issuedAt: { lt: before } },
        orderBy: { issuedAt: 'desc' },
        take: limit,
        select: { id: true, organizationId: true, kind: true, title: true, issuedAt: true },
      }),
    ]);

    const org = (id: string | null) => orgs.find((o) => o.id === id);
    const customerOrg = (customerId: string) =>
      scoped.find((l) => l.customerId === customerId)?.organizationId ?? null;

    const entries: TimelineEntry[] = [
      ...payments.map((p) => ({
        id: `pay_${p.id}`,
        kind: 'PAYMENT',
        organizationId: p.organizationId,
        businessName: org(p.organizationId)?.name ?? null,
        businessLogoFileId: org(p.organizationId)?.logoFileId ?? null,
        title: p.status === 'PAID' ? 'Payment made' : 'Payment attempted',
        detail: p.method,
        status: p.status,
        amount: money(p.amount),
        currency: p.currency,
        deeplink: p.orderId
          ? `vhicasar://business/${p.organizationId}/order/${p.orderId}`
          : `vhicasar://business/${p.organizationId}`,
        at: p.createdAt,
      })),
      ...orders.map((o) => ({
        id: `ord_${o.id}`,
        kind: 'ORDER',
        organizationId: o.organizationId,
        businessName: org(o.organizationId)?.name ?? null,
        businessLogoFileId: org(o.organizationId)?.logoFileId ?? null,
        title: `Order ${o.number}`,
        detail: null,
        status: o.status,
        amount: money(o.total),
        currency: o.currency,
        deeplink: `vhicasar://business/${o.organizationId}/order/${o.id}`,
        at: o.createdAt,
      })),
      ...meetings.map((m) => ({
        id: `mtg_${m.id}`,
        kind: 'BOOKING',
        organizationId: m.organizationId,
        businessName: org(m.organizationId)?.name ?? null,
        businessLogoFileId: org(m.organizationId)?.logoFileId ?? null,
        title: m.title,
        detail: m.startAt.toISOString(),
        status: m.status,
        amount: null,
        currency: null,
        deeplink: `vhicasar://business/${m.organizationId}/booking/${m.id}`,
        at: m.createdAt,
      })),
      ...loyalty.map((l) => {
        const orgId = customerOrg(l.account.customerId);
        return {
          id: `loy_${l.id}`,
          kind: 'LOYALTY',
          organizationId: orgId,
          businessName: org(orgId)?.name ?? null,
          businessLogoFileId: org(orgId)?.logoFileId ?? null,
          title: l.points >= 0 ? `Earned ${l.points} points` : `Redeemed ${Math.abs(l.points)} points`,
          detail: l.note,
          status: l.type,
          amount: null,
          currency: null,
          deeplink: orgId ? `vhicasar://business/${orgId}/loyalty` : null,
          at: l.createdAt,
        };
      }),
      ...rewards.map((r) => ({
        id: `rwd_${r.id}`,
        kind: 'REWARD',
        organizationId: r.organizationId,
        businessName: org(r.organizationId)?.name ?? null,
        businessLogoFileId: org(r.organizationId)?.logoFileId ?? null,
        title: 'Cashback reward',
        detail: r.status === 'PENDING_REVIEW' ? 'Being reviewed' : null,
        status: r.status,
        amount: money(r.rewardAmount),
        currency: r.currency,
        deeplink: 'vhicasar://wallet',
        at: r.createdAt,
      })),
      ...documents.map((d) => ({
        id: `doc_${d.id}`,
        kind: 'DOCUMENT',
        organizationId: d.organizationId,
        businessName: org(d.organizationId)?.name ?? null,
        businessLogoFileId: org(d.organizationId)?.logoFileId ?? null,
        title: d.title,
        detail: d.kind,
        status: null,
        amount: null,
        currency: null,
        deeplink: `vhicasar://documents/${d.id}`,
        at: d.issuedAt,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);

    return { items: entries };
  },

  /**
   * Things the customer needs to act on soon (§15), each with the action that
   * resolves it. Ordered by urgency, not by type.
   */
  async upcomingActions(vhicasarId: string, currency = 'NGN') {
    const links = await linkedBusinesses(vhicasarId);
    const customerIds = links.map((l) => l.customerId);
    const orgIds = links.map((l) => l.organizationId);
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 864e5);

    const [invoices, bookings, expiringRewards, expiringPromotions, wallet, orgs] = await Promise.all([
      customerIds.length
        ? prismaUnscoped.invoice.findMany({
            where: {
              customerId: { in: customerIds },
              status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
            },
            orderBy: { dueAt: 'asc' },
            take: 10,
            select: {
              id: true, number: true, organizationId: true, total: true,
              amountPaid: true, currency: true, dueAt: true, status: true,
            },
          })
        : [],
      customerIds.length
        ? prismaUnscoped.meeting.findMany({
            where: { customerId: { in: customerIds }, startAt: { gte: now, lte: in7 }, status: { not: 'CANCELLED' } },
            orderBy: { startAt: 'asc' },
            take: 10,
            select: { id: true, organizationId: true, title: true, startAt: true },
          })
        : [],
      prismaUnscoped.rewardGrant.findMany({
        where: { vhicasarId, status: 'GRANTED', expiresAt: { gte: now, lte: in7 } },
        orderBy: { expiresAt: 'asc' },
        take: 5,
        select: { id: true, rewardAmount: true, currency: true, expiresAt: true },
      }),
      orgIds.length
        ? prismaUnscoped.promotion.findMany({
            where: {
              organizationId: { in: orgIds },
              status: 'ACTIVE',
              endsAt: { gte: now, lte: in7 },
            },
            orderBy: { endsAt: 'asc' },
            take: 5,
            select: { id: true, organizationId: true, name: true, endsAt: true },
          })
        : [],
      walletBuckets.breakdown(vhicasarId, currency),
      prismaUnscoped.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      }),
    ]);

    const nameOf = (id: string | null) => orgs.find((o) => o.id === id)?.name ?? 'A business';

    const actions = [
      ...invoices.map((i) => {
        const outstanding = i.total.minus(i.amountPaid);
        const overdue = i.dueAt != null && i.dueAt < now;
        return {
          id: `inv_${i.id}`,
          kind: overdue ? 'INVOICE_OVERDUE' : 'INVOICE_DUE',
          urgency: overdue ? 0 : 2,
          title: `${overdue ? 'Overdue' : 'Invoice due'}: ${nameOf(i.organizationId)}`,
          detail: `Invoice ${i.number}`,
          amount: money(outstanding),
          currency: i.currency,
          dueAt: i.dueAt,
          action: 'PAY',
          organizationId: i.organizationId,
          deeplink: `vhicasar://business/${i.organizationId}/invoice/${i.id}`,
        };
      }),
      ...bookings.map((b) => {
        const isToday = b.startAt.toDateString() === now.toDateString();
        return {
          id: `bkg_${b.id}`,
          kind: isToday ? 'BOOKING_TODAY' : 'BOOKING_UPCOMING',
          urgency: isToday ? 1 : 3,
          title: isToday ? `Today: ${b.title}` : b.title,
          detail: nameOf(b.organizationId),
          amount: null,
          currency: null,
          dueAt: b.startAt,
          action: 'VIEW',
          organizationId: b.organizationId,
          deeplink: `vhicasar://business/${b.organizationId}/booking/${b.id}`,
        };
      }),
      ...expiringRewards.map((r) => ({
        id: `rwx_${r.id}`,
        kind: 'REWARD_EXPIRING',
        urgency: 2,
        title: 'Reward expiring soon',
        detail: `Use it before ${r.expiresAt?.toDateString() ?? 'it expires'}`,
        amount: money(r.rewardAmount),
        currency: r.currency,
        dueAt: r.expiresAt,
        action: 'SPEND',
        organizationId: null,
        deeplink: 'vhicasar://wallet',
      })),
      ...expiringPromotions.map((p) => ({
        id: `prx_${p.id}`,
        kind: 'PROMOTION_EXPIRING',
        urgency: 3,
        title: `Ending soon: ${p.name}`,
        detail: nameOf(p.organizationId),
        amount: null,
        currency: null,
        dueAt: p.endsAt,
        action: 'VIEW',
        organizationId: p.organizationId,
        deeplink: `vhicasar://business/${p.organizationId}/promotion/${p.id}`,
      })),
    ];

    // A wallet too low to cover what's owed is itself an action.
    const owed = invoices.reduce((sum, i) => sum.plus(i.total.minus(i.amountPaid)), ZERO);
    if (owed.greaterThan(0) && new Prisma.Decimal(wallet.total).lessThan(owed)) {
      actions.push({
        id: 'wallet_low',
        kind: 'LOW_WALLET_BALANCE',
        urgency: 1,
        title: 'Wallet balance is below what you owe',
        detail: `You owe ${money(owed)} and hold ${wallet.total}`,
        amount: wallet.total,
        currency,
        dueAt: null,
        action: 'TOP_UP',
        organizationId: null,
        deeplink: 'vhicasar://wallet/topup',
      });
    }

    actions.sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency - b.urgency;
      const at = a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at - bt;
    });

    return { items: actions };
  },

  /**
   * Proactive insights (§15).
   *
   * Deliberately computed from the customer's *own* aggregated data — never by
   * showing one business what another is doing. Each insight is something the
   * customer could work out themselves by opening every business in turn; the
   * value is that they don't have to.
   */
  async insights(vhicasarId: string, currency = 'NGN') {
    const links = await linkedBusinesses(vhicasarId);
    const orgIds = links.map((l) => l.organizationId);
    const customerIds = links.map((l) => l.customerId);
    const now = new Date();
    const inWeek = new Date(now.getTime() + 7 * 864e5);

    const [expiringPromos, expiringRewards, loyaltyAccounts, wallet, rewardAccount, orgs] =
      await Promise.all([
        orgIds.length
          ? prismaUnscoped.promotion.findMany({
              where: { organizationId: { in: orgIds }, status: 'ACTIVE', endsAt: { gte: now, lte: inWeek } },
              select: { id: true, name: true, organizationId: true, endsAt: true },
            })
          : [],
        prismaUnscoped.rewardGrant.findMany({
          where: { vhicasarId, status: 'GRANTED', expiresAt: { gte: now, lte: inWeek } },
          select: { rewardAmount: true, currency: true, expiresAt: true },
        }),
        customerIds.length
          ? prismaUnscoped.loyaltyAccount.findMany({
              where: { customerId: { in: customerIds } },
              select: {
                balance: true, tier: true, customerId: true,
                program: { select: { organizationId: true, redeemRate: true, name: true } },
              },
            })
          : [],
        walletBuckets.breakdown(vhicasarId, currency),
        prismaUnscoped.rewardAccount.findUnique({ where: { vhicasarId }, select: { balance: true, tier: true } }),
        prismaUnscoped.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        }),
      ]);

    const nameOf = (id: string | null | undefined) => orgs.find((o) => o.id === id)?.name ?? 'a business';
    const insights: Array<{ kind: string; message: string; action?: string; deeplink?: string; priority: number }> = [];

    if (expiringPromos.length > 0) {
      insights.push({
        kind: 'PROMOTIONS_EXPIRING',
        message:
          expiringPromos.length === 1
            ? `"${expiringPromos[0]!.name}" at ${nameOf(expiringPromos[0]!.organizationId)} ends this week.`
            : `You have ${expiringPromos.length} promotions expiring within a week.`,
        action: 'View offers',
        deeplink:
          expiringPromos.length === 1
            ? `vhicasar://business/${expiringPromos[0]!.organizationId}/promotion/${expiringPromos[0]!.id}`
            : 'vhicasar://businesses',
        priority: 1,
      });
    }

    if (expiringRewards.length > 0) {
      const total = expiringRewards.reduce((sum, r) => sum.plus(r.rewardAmount), ZERO);
      const soonest = expiringRewards
        .map((r) => r.expiresAt)
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const days = soonest ? Math.max(0, Math.ceil((soonest.getTime() - now.getTime()) / 864e5)) : 0;
      insights.push({
        kind: 'REWARDS_EXPIRING',
        message: `${money(total)} ${currency} of reward balance expires in ${days} day${days === 1 ? '' : 's'}.`,
        action: 'Spend it',
        deeplink: 'vhicasar://wallet',
        priority: 0,
      });
    }

    // Where the customer has enough points to be worth redeeming.
    const redeemable = loyaltyAccounts
      .filter((a) => a.program && a.balance > 0)
      .map((a) => ({
        organizationId: a.program!.organizationId,
        balance: a.balance,
        value: new Prisma.Decimal(a.balance).mul(a.program!.redeemRate),
      }))
      .filter((a) => a.value.greaterThanOrEqualTo(500))
      .sort((a, b) => (b.value.greaterThan(a.value) ? 1 : -1));

    if (redeemable.length > 0) {
      const best = redeemable[0]!;
      insights.push({
        kind: 'POINTS_REDEEMABLE',
        message: `Your ${best.balance} points at ${nameOf(best.organizationId)} are worth about ${money(best.value)} ${currency}.`,
        action: 'Redeem',
        deeplink: `vhicasar://business/${best.organizationId}/loyalty`,
        priority: 2,
      });
    }

    if (new Prisma.Decimal(wallet.locked).greaterThan(0)) {
      insights.push({
        kind: 'LOCKED_FUNDS',
        message: `${wallet.locked} ${currency} is locked for Vhicasar payments — spend it at any participating business.`,
        action: 'Find businesses',
        deeplink: 'vhicasar://discover',
        priority: 3,
      });
    }

    if (rewardAccount && rewardAccount.balance > 0) {
      insights.push({
        kind: 'UNIVERSAL_POINTS',
        message: `You have ${rewardAccount.balance} Vhicasar points (${rewardAccount.tier}) usable at any business.`,
        action: 'View rewards',
        deeplink: 'vhicasar://rewards',
        priority: 4,
      });
    }

    if (links.length === 0) {
      insights.push({
        kind: 'GET_STARTED',
        message: 'Connect to a business to start earning points and receiving offers.',
        action: 'Find a business',
        deeplink: 'vhicasar://discover',
        priority: 0,
      });
    }

    insights.sort((a, b) => a.priority - b.priority);
    return { items: insights.slice(0, 6) };
  },
};
