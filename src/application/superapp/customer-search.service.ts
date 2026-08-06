import { Prisma } from '@prisma/client';
import type { CustomerNotificationCategory, CustomerDocumentKind } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';

/**
 * Universal search, grouped notifications and the document vault (§15).
 *
 * Search spans every business a customer belongs to, but only through their own
 * `CustomerLink` rows — a customer can never match a record belonging to a
 * business they have not joined, and businesses never see each other's hits.
 */

const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal | null | undefined) => (v ?? ZERO).toFixed(2);

export interface SearchHit {
  id: string;
  category: string;
  title: string;
  subtitle: string | null;
  organizationId: string | null;
  businessName: string | null;
  amount: string | null;
  currency: string | null;
  deeplink: string;
  at: Date | null;
}

async function scope(vhicasarId: string) {
  const links = await prismaUnscoped.customerLink.findMany({
    where: { vhicasarId, status: 'ACTIVE' },
    select: { organizationId: true, customerId: true },
  });
  return {
    orgIds: links.map((l) => l.organizationId),
    customerIds: links.map((l) => l.customerId),
    orgOf: (customerId: string) => links.find((l) => l.customerId === customerId)?.organizationId ?? null,
  };
}

export const customerSearch = {
  /**
   * One query, categorised results (§15). Each category is capped so a broad
   * term stays fast and no single type crowds out the rest.
   */
  async search(vhicasarId: string, query: string, perCategory = 5) {
    const q = query.trim();
    if (q.length < 2) return { query: q, groups: [], total: 0 };

    const { orgIds, customerIds, orgOf } = await scope(vhicasarId);
    const like = { contains: q, mode: 'insensitive' as const };

    const [orgs, businesses, orders, invoices, quotations, meetings, payments, promotions, coupons, documents, notifications, properties] =
      await Promise.all([
        orgIds.length
          ? prismaUnscoped.organization.findMany({
              where: { id: { in: orgIds } },
              select: { id: true, name: true, logoFileId: true },
            })
          : [],
        // Businesses the customer belongs to, matched by name.
        orgIds.length
          ? prismaUnscoped.organization.findMany({
              where: { id: { in: orgIds }, name: like },
              take: perCategory,
              select: { id: true, name: true, businessType: true, city: true },
            })
          : [],
        customerIds.length
          ? prismaUnscoped.order.findMany({
              where: { customerId: { in: customerIds }, number: like },
              take: perCategory,
              orderBy: { createdAt: 'desc' },
              select: { id: true, organizationId: true, number: true, status: true, total: true, currency: true, createdAt: true },
            })
          : [],
        customerIds.length
          ? prismaUnscoped.invoice.findMany({
              where: { customerId: { in: customerIds }, number: like },
              take: perCategory,
              orderBy: { createdAt: 'desc' },
              select: { id: true, organizationId: true, number: true, status: true, total: true, amountPaid: true, currency: true, createdAt: true },
            })
          : [],
        customerIds.length
          ? prismaUnscoped.quotation.findMany({
              where: { customerId: { in: customerIds }, number: like },
              take: perCategory,
              orderBy: { createdAt: 'desc' },
              select: { id: true, organizationId: true, number: true, status: true, total: true, currency: true, createdAt: true },
            })
          : [],
        customerIds.length
          ? prismaUnscoped.meeting.findMany({
              where: { customerId: { in: customerIds }, title: like },
              take: perCategory,
              orderBy: { startAt: 'desc' },
              select: { id: true, organizationId: true, title: true, status: true, startAt: true },
            })
          : [],
        customerIds.length
          ? prismaUnscoped.payment.findMany({
              where: { customerId: { in: customerIds }, providerRef: like },
              take: perCategory,
              orderBy: { createdAt: 'desc' },
              select: { id: true, organizationId: true, amount: true, currency: true, method: true, status: true, createdAt: true, orderId: true },
            })
          : [],
        orgIds.length
          ? prismaUnscoped.promotion.findMany({
              where: { organizationId: { in: orgIds }, status: 'ACTIVE', name: like },
              take: perCategory,
              select: { id: true, organizationId: true, name: true, kind: true, endsAt: true },
            })
          : [],
        orgIds.length
          ? prismaUnscoped.coupon.findMany({
              where: { organizationId: { in: orgIds }, isActive: true, code: like },
              take: perCategory,
              select: { id: true, organizationId: true, code: true, discountType: true, discountValue: true },
            })
          : [],
        prismaUnscoped.customerDocument.findMany({
          where: { vhicasarId, title: like },
          take: perCategory,
          orderBy: { issuedAt: 'desc' },
          select: { id: true, organizationId: true, title: true, kind: true, amount: true, currency: true, issuedAt: true },
        }),
        prismaUnscoped.customerNotification.findMany({
          where: { vhicasarId, OR: [{ title: like }, { body: like }] },
          take: perCategory,
          orderBy: { createdAt: 'desc' },
          select: { id: true, organizationId: true, title: true, category: true, createdAt: true, data: true },
        }),
        orgIds.length
          ? prismaUnscoped.property.findMany({
              where: { organizationId: { in: orgIds }, title: like },
              take: perCategory,
              select: { id: true, organizationId: true, title: true, status: true, price: true, currency: true },
            })
          : [],
      ]);

    const nameOf = (id: string | null) => orgs.find((o) => o.id === id)?.name ?? null;

    const groups: Array<{ category: string; items: SearchHit[] }> = [];
    const add = (category: string, items: SearchHit[]) => {
      if (items.length > 0) groups.push({ category, items });
    };

    add('Businesses', businesses.map((b) => ({
      id: b.id, category: 'BUSINESS', title: b.name,
      subtitle: [b.businessType, b.city].filter(Boolean).join(' · ') || null,
      organizationId: b.id, businessName: b.name, amount: null, currency: null,
      deeplink: `vhicasar://business/${b.id}`, at: null,
    })));

    add('Orders', orders.map((o) => ({
      id: o.id, category: 'ORDER', title: `Order ${o.number}`, subtitle: o.status,
      organizationId: o.organizationId, businessName: nameOf(o.organizationId),
      amount: money(o.total), currency: o.currency,
      deeplink: `vhicasar://business/${o.organizationId}/order/${o.id}`, at: o.createdAt,
    })));

    add('Invoices', invoices.map((i) => ({
      id: i.id, category: 'INVOICE', title: `Invoice ${i.number}`, subtitle: i.status,
      organizationId: i.organizationId, businessName: nameOf(i.organizationId),
      amount: money(i.total.minus(i.amountPaid)), currency: i.currency,
      deeplink: `vhicasar://business/${i.organizationId}/invoice/${i.id}`, at: i.createdAt,
    })));

    add('Quotations', quotations.map((q2) => ({
      id: q2.id, category: 'QUOTATION', title: `Quotation ${q2.number}`, subtitle: q2.status,
      organizationId: q2.organizationId, businessName: nameOf(q2.organizationId),
      amount: money(q2.total), currency: q2.currency,
      deeplink: `vhicasar://business/${q2.organizationId}/quotation/${q2.id}`, at: q2.createdAt,
    })));

    add('Bookings', meetings.map((m) => ({
      id: m.id, category: 'BOOKING', title: m.title, subtitle: m.status,
      organizationId: m.organizationId, businessName: nameOf(m.organizationId),
      amount: null, currency: null,
      deeplink: `vhicasar://business/${m.organizationId}/booking/${m.id}`, at: m.startAt,
    })));

    add('Payments', payments.map((p) => ({
      id: p.id, category: 'PAYMENT', title: `${p.method} payment`, subtitle: p.status,
      organizationId: p.organizationId, businessName: nameOf(p.organizationId),
      amount: money(p.amount), currency: p.currency,
      deeplink: p.orderId
        ? `vhicasar://business/${p.organizationId}/order/${p.orderId}`
        : `vhicasar://business/${p.organizationId}`,
      at: p.createdAt,
    })));

    add('Promotions', promotions.map((p) => ({
      id: p.id, category: 'PROMOTION', title: p.name, subtitle: p.kind,
      organizationId: p.organizationId, businessName: nameOf(p.organizationId),
      amount: null, currency: null,
      deeplink: `vhicasar://business/${p.organizationId}/promotion/${p.id}`, at: p.endsAt,
    })));

    add('Coupons', coupons.map((c) => ({
      id: c.id, category: 'COUPON', title: c.code,
      subtitle: c.discountType === 'PERCENTAGE' ? `${c.discountValue}% off` : `${c.discountValue} off`,
      organizationId: c.organizationId, businessName: nameOf(c.organizationId),
      amount: null, currency: null,
      deeplink: `vhicasar://business/${c.organizationId}/promotions`, at: null,
    })));

    add('Properties', properties.map((p) => ({
      id: p.id, category: 'PROPERTY', title: p.title, subtitle: p.status,
      organizationId: p.organizationId, businessName: nameOf(p.organizationId),
      amount: p.price ? money(p.price) : null, currency: p.currency ?? null,
      deeplink: `vhicasar://business/${p.organizationId}/property/${p.id}`, at: null,
    })));

    add('Documents', documents.map((d) => ({
      id: d.id, category: 'DOCUMENT', title: d.title, subtitle: d.kind,
      organizationId: d.organizationId, businessName: nameOf(d.organizationId),
      amount: d.amount ? money(d.amount) : null, currency: d.currency,
      deeplink: `vhicasar://documents/${d.id}`, at: d.issuedAt,
    })));

    add('Notifications', notifications.map((n) => ({
      id: n.id, category: 'NOTIFICATION', title: n.title, subtitle: n.category,
      organizationId: n.organizationId, businessName: nameOf(n.organizationId),
      amount: null, currency: null,
      deeplink: ((n.data as Record<string, unknown> | null)?.deeplink as string) ?? 'vhicasar://notifications',
      at: n.createdAt,
    })));

    return { query: q, groups, total: groups.reduce((sum, g) => sum + g.items.length, 0) };
  },

  // ---- Notifications, grouped (§15) ----

  async notifications(
    vhicasarId: string,
    opts: { category?: CustomerNotificationCategory; organizationId?: string; unreadOnly?: boolean; limit?: number; cursor?: string } = {}
  ) {
    const limit = opts.limit ?? 30;
    const rows = await prismaUnscoped.customerNotification.findMany({
      where: {
        vhicasarId,
        ...(opts.category ? { category: opts.category } : {}),
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        ...(opts.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const orgIds = [...new Set(items.map((n) => n.organizationId).filter((x): x is string => Boolean(x)))];
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true, logoFileId: true },
        })
      : [];

    return {
      items: items.map((n) => {
        const org = orgs.find((o) => o.id === n.organizationId);
        return {
          id: n.id,
          category: n.category,
          organizationId: n.organizationId,
          businessName: org?.name ?? null,
          businessLogoFileId: org?.logoFileId ?? null,
          title: n.title,
          body: n.body,
          deeplink: ((n.data as Record<string, unknown> | null)?.deeplink as string) ?? null,
          isRead: n.readAt != null,
          createdAt: n.createdAt,
        };
      }),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /** Unread counts per business and per category, for the grouped feed UI. */
  async notificationSummary(vhicasarId: string) {
    const [byCategory, byOrg, total] = await Promise.all([
      prismaUnscoped.customerNotification.groupBy({
        by: ['category'],
        where: { vhicasarId, readAt: null },
        _count: { _all: true },
      }),
      prismaUnscoped.customerNotification.groupBy({
        by: ['organizationId'],
        where: { vhicasarId, readAt: null },
        _count: { _all: true },
      }),
      prismaUnscoped.customerNotification.count({ where: { vhicasarId, readAt: null } }),
    ]);

    const orgIds = byOrg.map((o) => o.organizationId).filter((x): x is string => Boolean(x));
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : [];

    return {
      unread: total,
      byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])),
      byBusiness: byOrg.map((o) => ({
        organizationId: o.organizationId,
        name: o.organizationId ? (orgs.find((x) => x.id === o.organizationId)?.name ?? '—') : 'Vhicasar',
        unread: o._count._all,
      })),
    };
  },

  async markRead(vhicasarId: string, ids?: string[]) {
    const { count } = await prismaUnscoped.customerNotification.updateMany({
      where: { vhicasarId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { marked: count };
  },

  // ---- Document vault (§15) ----

  async documents(
    vhicasarId: string,
    opts: { kind?: CustomerDocumentKind; organizationId?: string; q?: string; limit?: number; cursor?: string } = {}
  ) {
    const limit = opts.limit ?? 30;
    const rows = await prismaUnscoped.customerDocument.findMany({
      where: {
        vhicasarId,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        ...(opts.q ? { title: { contains: opts.q, mode: 'insensitive' } } : {}),
      },
      orderBy: { issuedAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const orgIds = [...new Set(items.map((d) => d.organizationId))];
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, logoFileId: true } })
      : [];

    return {
      items: items.map((d) => {
        const org = orgs.find((o) => o.id === d.organizationId);
        return {
          id: d.id,
          kind: d.kind,
          title: d.title,
          organizationId: d.organizationId,
          businessName: org?.name ?? null,
          businessLogoFileId: org?.logoFileId ?? null,
          amount: d.amount ? money(d.amount) : null,
          currency: d.currency,
          hasFile: d.fileId != null,
          isShareable: d.isShareable,
          sourceType: d.sourceType,
          sourceId: d.sourceId,
          issuedAt: d.issuedAt,
        };
      }),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * Resolve a document to something downloadable. Returns the storage key only
   * for a document this customer actually owns.
   */
  async documentFile(vhicasarId: string, documentId: string) {
    const doc = await prismaUnscoped.customerDocument.findFirst({
      where: { id: documentId, vhicasarId },
    });
    if (!doc) throw new NotFoundError('Document');
    if (!doc.fileId) return { document: doc, file: null };

    const file = await prismaUnscoped.file.findUnique({
      where: { id: doc.fileId },
      select: { id: true, key: true, fileName: true, mimeType: true, sizeBytes: true },
    });
    return { document: doc, file };
  },

  /** Record a document a business issued to a customer. */
  async issueDocument(params: {
    vhicasarId: string;
    organizationId: string;
    kind: CustomerDocumentKind;
    title: string;
    fileId?: string;
    sourceType?: string;
    sourceId?: string;
    amount?: Prisma.Decimal | number | string;
    currency?: string;
    isShareable?: boolean;
  }) {
    return prismaUnscoped.customerDocument.create({
      data: {
        vhicasarId: params.vhicasarId,
        organizationId: params.organizationId,
        kind: params.kind,
        title: params.title,
        fileId: params.fileId ?? null,
        sourceType: params.sourceType ?? null,
        sourceId: params.sourceId ?? null,
        amount: params.amount != null ? new Prisma.Decimal(params.amount) : null,
        currency: params.currency ?? null,
        isShareable: params.isShareable ?? true,
      },
    });
  },
};

/**
 * Deliver a notification to a customer's in-app feed.
 *
 * Separate from push: push may fail or be disabled, but the feed is the record
 * the customer can always come back to.
 */
export async function notifyCustomer(params: {
  vhicasarId: string;
  organizationId?: string | null;
  category: CustomerNotificationCategory;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}) {
  return prismaUnscoped.customerNotification.create({
    data: {
      vhicasarId: params.vhicasarId,
      organizationId: params.organizationId ?? null,
      category: params.category,
      title: params.title,
      body: params.body ?? null,
      data: (params.data ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
