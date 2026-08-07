import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { promotionEngine } from '../marketing/promotion-engine.service';

/**
 * Per-business dashboard for the Customer Super App (§4, §8).
 *
 * Every read is anchored to the caller's own CustomerLink, so a customer can
 * only ever see the business's data *about them* — switching businesses
 * changes which link is used, never the isolation rules.
 */

/** Resolve the caller's customer record for a business, or refuse. */
async function requireLink(vhicasarId: string, organizationId: string) {
  const link = await prismaUnscoped.customerLink.findUnique({
    where: { vhicasarId_organizationId: { vhicasarId, organizationId } },
  });
  if (!link || link.status !== 'ACTIVE') {
    throw new ForbiddenError('You are not connected to this business.');
  }
  return link;
}

const decimalStr = (v: Prisma.Decimal | null | undefined) => (v ?? new Prisma.Decimal(0)).toFixed(2);

export const businessDashboard = {
  requireLink,

  /**
   * The compact card shown in the business list (§8): just enough to decide
   * whether to open it. Computed for many businesses at once, so it stays to
   * grouped queries rather than per-business round-trips.
   */
  async cards(vhicasarId: string) {
    const links = await prismaUnscoped.customerLink.findMany({
      where: { vhicasarId, status: 'ACTIVE' },
      orderBy: [{ isPinned: 'desc' }, { lastAccessedAt: 'desc' }, { linkedAt: 'desc' }],
      select: {
        id: true,
        organizationId: true,
        customerId: true,
        isPinned: true,
        isHidden: true,
        isFavourite: true,
        lastAccessedAt: true,
        linkedAt: true,
        unreadPromotions: true,
      },
    });
    if (links.length === 0) return [];

    const orgIds = links.map((l) => l.organizationId);
    const customerIds = links.map((l) => l.customerId);
    const now = new Date();

    const [orgs, loyaltyAccounts, promotions, coupons, wallets] = await Promise.all([
      prismaUnscoped.organization.findMany({
        where: { id: { in: orgIds } },
        select: {
          id: true,
          name: true,
          logoFileId: true,
          businessType: true,
          currency: true,
          businessProfile: { select: { category: true, coverImageUrl: true } },
        },
      }),
      prismaUnscoped.loyaltyAccount.findMany({
        where: { customerId: { in: customerIds } },
        select: { customerId: true, balance: true, tier: true },
      }),
      prismaUnscoped.promotion.groupBy({
        by: ['organizationId'],
        where: {
          organizationId: { in: orgIds },
          status: 'ACTIVE',
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
        _count: { _all: true },
      }),
      prismaUnscoped.coupon.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: orgIds }, isActive: true },
        _count: { _all: true },
      }),
      prismaUnscoped.wallet.findMany({
        where: { organizationId: { in: orgIds }, vhicasarId, purpose: 'USER' },
        select: { organizationId: true, balance: true, currency: true },
      }),
    ]);

    return links.map((link) => {
      const org = orgs.find((o) => o.id === link.organizationId);
      const loyalty = loyaltyAccounts.find((a) => a.customerId === link.customerId);
      const promoCount = promotions.find((p) => p.organizationId === link.organizationId)?._count._all ?? 0;
      const couponCount = coupons.find((c) => c.organizationId === link.organizationId)?._count._all ?? 0;
      const wallet = wallets.find((w) => w.organizationId === link.organizationId);

      return {
        organizationId: link.organizationId,
        name: org?.name ?? 'Business',
        logoFileId: org?.logoFileId ?? null,
        coverImageUrl: org?.businessProfile?.coverImageUrl ?? null,
        category: org?.businessProfile?.category ?? null,
        businessType: org?.businessType ?? null,
        currency: org?.currency ?? 'NGN',
        points: loyalty?.balance ?? 0,
        tier: loyalty?.tier ?? null,
        activePromotions: promoCount,
        /// Offers published since this customer last opened the offers list.
        unreadPromotions: link.unreadPromotions,
        availableCoupons: couponCount,
        walletBalance: wallet ? decimalStr(wallet.balance) : null,
        isPinned: link.isPinned,
        isHidden: link.isHidden,
        isFavourite: link.isFavourite,
        lastAccessedAt: link.lastAccessedAt,
        joinedAt: link.linkedAt,
      };
    });
  },

  /**
   * Every offer the customer can claim, across every business they belong to.
   *
   * The per-business screen only helps someone who already knows which shop to
   * look in; this is the "what have I got?" view. Claimability is decided by
   * the promotion engine per business, so nothing appears here that would be
   * refused at the till.
   */
  async allPromotions(vhicasarId: string) {
    const links = await prismaUnscoped.customerLink.findMany({
      where: { vhicasarId, status: 'ACTIVE', isHidden: false },
      select: { organizationId: true, customerId: true },
    });
    if (links.length === 0) return { items: [], businesses: 0, total: 0 };

    const orgs = await prismaUnscoped.organization.findMany({
      where: { id: { in: links.map((l) => l.organizationId) } },
      select: {
        id: true,
        name: true,
        logoFileId: true,
        currency: true,
        businessProfile: { select: { coverImageUrl: true } },
      },
    });

    const perBusiness = await Promise.all(
      links.map(async (link) => {
        const offers = await promotionEngine.availableFor(link.organizationId, link.customerId);
        const org = orgs.find((o) => o.id === link.organizationId);
        return offers.map((o) => ({
          ...o,
          organizationId: link.organizationId,
          businessName: org?.name ?? 'Business',
          businessLogoFileId: org?.logoFileId ?? null,
          businessCoverImageUrl: org?.businessProfile?.coverImageUrl ?? null,
          currency: org?.currency ?? 'NGN',
          deeplink: `vhicasar://business/${link.organizationId}/promotion/${o.id}`,
        }));
      })
    );

    // Soonest to expire first: the offer about to be lost is the one worth
    // showing at the top.
    const items = perBusiness.flat().sort((a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime());
    return {
      items,
      businesses: new Set(items.map((i) => i.organizationId)).size,
      total: items.length,
    };
  },

  /** Full dashboard for one business (§4). */
  async dashboard(vhicasarId: string, organizationId: string) {
    const link = await requireLink(vhicasarId, organizationId);
    const customerId = link.customerId;
    const now = new Date();

    const [org, loyalty, orders, appointments, invoices, promotions, coupons, payments, wallet, addresses] =
      await Promise.all([
        prismaUnscoped.organization.findUnique({
          where: { id: organizationId },
          select: {
            id: true,
            name: true,
            logoFileId: true,
            currency: true,
            businessType: true,
            businessProfile: { select: { coverImageUrl: true, category: true, acceptsLockedFunds: true } },
          },
        }),
        prismaUnscoped.loyaltyAccount.findUnique({
          where: { customerId },
          select: { balance: true, tier: true, program: { select: { name: true, redeemRate: true } } },
        }),
        prismaUnscoped.order.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true },
        }),
        prismaUnscoped.meeting.findMany({
          where: { customerId, startAt: { gte: now } },
          orderBy: { startAt: 'asc' },
          take: 5,
          select: { id: true, title: true, startAt: true, status: true },
        }),
        prismaUnscoped.invoice.findMany({
          where: { customerId, status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
          orderBy: { dueAt: 'asc' },
          take: 5,
          select: { id: true, number: true, total: true, amountPaid: true, currency: true, dueAt: true, status: true },
        }),
        prismaUnscoped.promotion.findMany({
          where: { organizationId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gte: now } },
          orderBy: { endsAt: 'asc' },
          take: 10,
          select: {
            id: true, name: true, description: true, kind: true, discountType: true,
            discountValue: true, endsAt: true, imageUrl: true, minSpend: true,
          },
        }),
        prismaUnscoped.coupon.findMany({
          where: { organizationId, isActive: true },
          take: 10,
          select: { id: true, code: true, discountType: true, discountValue: true, expiresAt: true },
        }),
        prismaUnscoped.payment.findMany({
          where: { customerId, status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, amount: true, currency: true, method: true, paidAt: true },
        }),
        prismaUnscoped.wallet.findFirst({
          where: { organizationId, vhicasarId, purpose: 'USER' },
          select: { balance: true, currency: true },
        }),
        prismaUnscoped.customerAddress.findMany({
          where: { customerId },
          select: { id: true, label: true, addressLine1: true, city: true, isDefault: true },
        }),
      ]);

    if (!org) throw new NotFoundError('Business');

    // Mark this as the business the customer is currently looking at, so the
    // app can reopen on it and "recent businesses" stays truthful.
    await prismaUnscoped.customerLink.update({
      where: { id: link.id },
      data: { lastAccessedAt: now },
    });

    return {
      business: {
        id: org.id,
        name: org.name,
        logoFileId: org.logoFileId,
        coverImageUrl: org.businessProfile?.coverImageUrl ?? null,
        category: org.businessProfile?.category ?? null,
        businessType: org.businessType,
        currency: org.currency,
        acceptsLockedFunds: org.businessProfile?.acceptsLockedFunds ?? true,
      },
      loyalty: loyalty
        ? {
            points: loyalty.balance,
            tier: loyalty.tier,
            programName: loyalty.program?.name ?? null,
            pointValue: loyalty.program ? loyalty.program.redeemRate.toString() : null,
          }
        : { points: 0, tier: null, programName: null, pointValue: null },
      wallet: wallet ? { balance: decimalStr(wallet.balance), currency: wallet.currency } : null,
      orders: orders.map((o) => ({
        id: o.id, number: o.number, status: o.status,
        total: decimalStr(o.total), currency: o.currency, createdAt: o.createdAt,
      })),
      appointments: appointments.map((a) => ({ id: a.id, title: a.title, startsAt: a.startAt, status: a.status })),
      invoices: invoices.map((i) => ({
        id: i.id, number: i.number, total: decimalStr(i.total),
        outstanding: decimalStr(i.total.minus(i.amountPaid)), currency: i.currency,
        dueDate: i.dueAt, status: i.status,
      })),
      promotions: promotions.map((p) => ({
        id: p.id, name: p.name, description: p.description, kind: p.kind,
        discountType: p.discountType, discountValue: p.discountValue.toString(),
        minSpend: p.minSpend ? decimalStr(p.minSpend) : null,
        endsAt: p.endsAt, imageUrl: p.imageUrl,
      })),
      coupons: coupons.map((c) => ({
        id: c.id, code: c.code, discountType: c.discountType,
        discountValue: c.discountValue.toString(), expiresAt: c.expiresAt,
      })),
      recentPayments: payments.map((p) => ({
        id: p.id, amount: decimalStr(p.amount), currency: p.currency,
        method: p.method, paidAt: p.paidAt,
      })),
      addresses,
      membership: { joinedAt: link.linkedAt, isPinned: link.isPinned, isFavourite: link.isFavourite },
    };
  },

  /** Counter badge for the business list (§8). */
  async counters(vhicasarId: string, organizationId: string) {
    const link = await requireLink(vhicasarId, organizationId);
    const now = new Date();
    const [promotions, coupons, loyalty, unpaidInvoices] = await Promise.all([
      prismaUnscoped.promotion.count({
        where: { organizationId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gte: now } },
      }),
      prismaUnscoped.coupon.count({ where: { organizationId, isActive: true } }),
      prismaUnscoped.loyaltyAccount.findUnique({
        where: { customerId: link.customerId },
        select: { balance: true, tier: true },
      }),
      prismaUnscoped.invoice.count({
        where: { customerId: link.customerId, status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
      }),
    ]);
    return {
      activePromotions: promotions,
      availableCoupons: coupons,
      points: loyalty?.balance ?? 0,
      tier: loyalty?.tier ?? null,
      unpaidInvoices,
    };
  },
};
