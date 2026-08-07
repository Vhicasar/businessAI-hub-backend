import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import type { BusinessQrKind } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { env } from '../../shared/config/env';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { normalizePhone, phoneVariants } from '../../shared/phone';
import { emitEvent } from '../../shared/domain-events';
import { auditService } from '../audit/audit.service';
import { customerMatcher } from '../customers/customer-matcher.service';

/**
 * Business discovery and joining (§2, §3).
 *
 * Search runs across every organisation, so it deliberately uses the unscoped
 * client — but it only ever returns the *public* profile fields a business has
 * opted to publish (`isDiscoverable`). No tenant business data is exposed here;
 * a customer only sees a business's private data after joining, and then only
 * through their own CustomerLink.
 */

const HMAC_KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

function qrSignature(code: string, organizationId: string, kind: string, expiresAtMs: number | null): string {
  return createHmac('sha256', HMAC_KEY)
    .update(`${code}.${organizationId}.${kind}.${expiresAtMs ?? 'never'}`)
    .digest('base64url');
}

function verifyQrSignature(qr: {
  code: string;
  organizationId: string;
  kind: string;
  expiresAt: Date | null;
  signature: string;
}): boolean {
  const expected = qrSignature(qr.code, qr.organizationId, qr.kind, qr.expiresAt?.getTime() ?? null);
  const a = Buffer.from(expected);
  const b = Buffer.from(qr.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What a customer sees about a business before joining. */
const publicBusinessView = (org: {
  id: string;
  name: string;
  slug: string;
  businessType: string;
  logoFileId: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  businessProfile: {
    tagline: string | null;
    description: string | null;
    coverImageUrl: string | null;
    category: string | null;
    openingHours: Prisma.JsonValue;
    rating: Prisma.Decimal;
    ratingCount: number;
    services: string[];
    handle: string | null;
  } | null;
}) => ({
  id: org.id,
  name: org.name,
  slug: org.slug,
  handle: org.businessProfile?.handle ?? org.slug,
  businessType: org.businessType,
  logoFileId: org.logoFileId,
  tagline: org.businessProfile?.tagline ?? null,
  description: org.businessProfile?.description ?? null,
  coverImageUrl: org.businessProfile?.coverImageUrl ?? null,
  category: org.businessProfile?.category ?? null,
  openingHours: org.businessProfile?.openingHours ?? null,
  rating: Number(org.businessProfile?.rating ?? 0),
  ratingCount: org.businessProfile?.ratingCount ?? 0,
  services: org.businessProfile?.services ?? [],
  city: org.city,
  country: org.country,
  phone: org.phone,
  email: org.email,
  website: org.website,
});

/** What a business with nothing running looks like, so the shape never varies. */
const EMPTY_OFFERS = { activePromotionCount: 0, topPromotion: null as string | null };

/**
 * Live-offer counts for a page of businesses, in one query.
 *
 * "Live" means the same thing here as on the promotion list: ACTIVE and inside
 * its date window. Time-of-day windows (happy hour) are deliberately *not*
 * applied — this is a shop-window count, and hiding a happy-hour deal at
 * breakfast would tell the customer the business has nothing on.
 */
async function livePromotionSummary(
  organizationIds: string[]
): Promise<Map<string, { activePromotionCount: number; topPromotion: string | null }>> {
  const out = new Map<string, { activePromotionCount: number; topPromotion: string | null }>();
  if (organizationIds.length === 0) return out;

  const now = new Date();
  const promotions = await prismaUnscoped.promotion.findMany({
    where: {
      organizationId: { in: organizationIds },
      status: 'ACTIVE',
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    select: { organizationId: true, name: true, endsAt: true },
    orderBy: { endsAt: 'asc' },
  });

  for (const p of promotions) {
    const entry = out.get(p.organizationId);
    if (entry) entry.activePromotionCount += 1;
    // Ordered by soonest-ending, so the first one seen is the most urgent.
    else out.set(p.organizationId, { activePromotionCount: 1, topPromotion: p.name });
  }
  return out;
}

const orgSelect = {
  id: true,
  name: true,
  slug: true,
  businessType: true,
  logoFileId: true,
  city: true,
  country: true,
  phone: true,
  email: true,
  website: true,
  businessProfile: {
    select: {
      tagline: true,
      description: true,
      coverImageUrl: true,
      category: true,
      openingHours: true,
      rating: true,
      ratingCount: true,
      services: true,
      handle: true,
    },
  },
} as const;

export const businessDiscovery = {
  /**
   * Search participating businesses by name, id/handle, phone, website,
   * category or location (§1). Only discoverable, active organisations.
   */
  async search(params: {
    q?: string;
    category?: string;
    country?: string;
    city?: string;
    limit: number;
    cursor?: string;
  }) {
    const q = params.q?.trim();
    const phoneMatches = q ? phoneVariants(q) : [];

    const where: Prisma.OrganizationWhereInput = {
      deletedAt: null,
      status: { in: ['ACTIVE', 'TRIAL'] },
      // A business is discoverable unless it has opted out. Requiring a profile
      // row would hide every organisation that hasn't filled one in yet.
      AND: [
        { OR: [{ businessProfile: { is: null } }, { businessProfile: { isDiscoverable: true } }] },
        ...(params.category ? [{ businessProfile: { category: params.category } }] : []),
      ],
      ...(params.country ? { country: params.country.toUpperCase() } : {}),
      ...(params.city ? { city: { contains: params.city, mode: 'insensitive' } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q.toLowerCase(), mode: 'insensitive' } },
              { id: q },
              { website: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              ...(phoneMatches.length ? [{ phone: { in: phoneMatches } }] : []),
              { businessProfile: { handle: q.toLowerCase() } },
              { businessProfile: { tagline: { contains: q, mode: 'insensitive' as const } } },
              { businessProfile: { tags: { has: q.toLowerCase() } } },
            ],
          }
        : {}),
    };

    const rows = await prismaUnscoped.organization.findMany({
      where,
      select: orgSelect,
      orderBy: [{ name: 'asc' }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;
    // Offers are the reason a customer taps through, so the count and the
    // headline deal ride along with the search result rather than waiting for
    // the profile screen.
    const offers = await livePromotionSummary(items.map((o) => o.id));
    return {
      items: items.map((o) => ({ ...publicBusinessView(o), ...(offers.get(o.id) ?? EMPTY_OFFERS) })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /** Full public profile plus what the customer would get by joining. */
  async profile(organizationId: string, vhicasarId?: string) {
    const org = await prismaUnscoped.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: orgSelect,
    });
    if (!org) throw new NotFoundError('Business');

    const [loyalty, promotions, link] = await Promise.all([
      prismaUnscoped.loyaltyProgram.findUnique({
        where: { organizationId },
        select: { name: true, pointsPerAmount: true, redeemRate: true, isActive: true },
      }),
      prismaUnscoped.promotion.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          startsAt: { lte: new Date() },
          endsAt: { gte: new Date() },
        },
        select: { id: true, name: true, description: true, kind: true, discountType: true, discountValue: true, endsAt: true, imageUrl: true },
        // Soonest to expire first, matching the search results — otherwise the
        // "top offer" on a card changes depending on which screen rendered it.
        orderBy: { endsAt: 'asc' },
        take: 10,
      }),
      vhicasarId
        ? prismaUnscoped.customerLink.findUnique({
            where: { vhicasarId_organizationId: { vhicasarId, organizationId } },
            select: { id: true, status: true, linkedAt: true },
          })
        : null,
    ]);

    return {
      ...publicBusinessView(org),
      loyaltyProgram: loyalty?.isActive
        ? { name: loyalty.name, pointsPerAmount: loyalty.pointsPerAmount.toString(), redeemRate: loyalty.redeemRate.toString() }
        : null,
      activePromotions: promotions.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        kind: p.kind,
        discountType: p.discountType,
        discountValue: p.discountValue.toString(),
        endsAt: p.endsAt,
        imageUrl: p.imageUrl,
      })),
      // Same two fields the search results carry, so a card rendered from
      // either payload shows the same badge.
      activePromotionCount: promotions.length,
      topPromotion: promotions[0]?.name ?? null,
      isJoined: Boolean(link && link.status === 'ACTIVE'),
      joinedAt: link?.linkedAt ?? null,
    };
  },

  /**
   * Associate a Vhicasar identity with a business, creating or matching the
   * organisation's own Customer record (§2 "merge intelligently").
   */
  async join(
    vhicasarId: string,
    organizationId: string,
    opts: { source?: string; qrCode?: string; referrerCustomerId?: string; campaignId?: string } = {}
  ) {
    const org = await prismaUnscoped.organization.findFirst({
      where: { id: organizationId, deletedAt: null, status: { in: ['ACTIVE', 'TRIAL'] } },
      select: { id: true, name: true, country: true },
    });
    if (!org) throw new NotFoundError('Business');

    const existing = await prismaUnscoped.customerLink.findUnique({
      where: { vhicasarId_organizationId: { vhicasarId, organizationId } },
    });
    if (existing) {
      if (existing.status === 'BLOCKED') {
        throw new ForbiddenError('This business has blocked your account.');
      }
      if (existing.status === 'UNLINKED') {
        // Re-joining should restore the original relationship, not fork a new
        // customer record and lose their history.
        const restored = await prismaUnscoped.customerLink.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', isHidden: false, lastAccessedAt: new Date() },
        });
        await this.recordHistory(vhicasarId, organizationId, 'REJOINED', opts);
        return { link: restored, created: false, rejoined: true, business: org.name };
      }
      await prismaUnscoped.customerLink.update({
        where: { id: existing.id },
        data: { lastAccessedAt: new Date() },
      });
      return { link: existing, created: false, rejoined: false, business: org.name };
    }

    const identity = await prismaUnscoped.vhicasarId.findUnique({ where: { id: vhicasarId } });
    if (!identity) throw new NotFoundError('Vhicasar ID');

    // Reuse the business's existing record for this person when there is one —
    // a walk-in who later installs the app must not become a second customer.
    const phone = normalizePhone(identity.phone, org.country ?? undefined);
    const match = await prismaUnscoped.customer.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        link: null,
        OR: [
          ...(identity.email ? [{ email: identity.email }] : []),
          ...(phone ? [{ phone: { in: phoneVariants(phone) } }] : []),
        ],
      },
    });

    const customer =
      match ??
      (await prismaUnscoped.customer.create({
        data: {
          organizationId,
          firstName: identity.firstName ?? 'Customer',
          lastName: identity.lastName,
          displayName: identity.displayName,
          email: identity.email,
          phone: identity.phone,
        },
      }));

    const link = await prismaUnscoped.customerLink.create({
      data: {
        vhicasarId,
        organizationId,
        customerId: customer.id,
        source: opts.source ?? 'SUPER_APP',
        lastAccessedAt: new Date(),
      },
    });

    await this.recordHistory(vhicasarId, organizationId, 'JOINED', opts);
    await emitEvent({
      name: 'CustomerLinked',
      aggregateType: 'CustomerLink',
      aggregateId: link.id,
      payload: {
        vhicasarId,
        customerId: customer.id,
        source: opts.source ?? 'SUPER_APP',
        merged: Boolean(match),
        referrerCustomerId: opts.referrerCustomerId ?? null,
      },
      organizationId,
    });

    return { link, created: !match, rejoined: false, business: org.name };
  },

  /** Leave a business, when the business permits self-service removal. */
  async leave(vhicasarId: string, organizationId: string) {
    const link = await prismaUnscoped.customerLink.findUnique({
      where: { vhicasarId_organizationId: { vhicasarId, organizationId } },
    });
    if (!link) throw new NotFoundError('Business membership');

    const profile = await prismaUnscoped.businessProfile.findUnique({
      where: { organizationId },
      select: { allowSelfLeave: true },
    });
    if (profile && !profile.allowSelfLeave) {
      throw new ForbiddenError('This business does not allow removing the connection from the app. Contact them directly.');
    }

    // Soft-unlink: the organisation keeps its Customer record (orders, invoices
    // and receipts must survive), the customer simply stops seeing it.
    await prismaUnscoped.customerLink.update({
      where: { id: link.id },
      data: { status: 'UNLINKED', isPinned: false, isFavourite: false },
    });
    await this.recordHistory(vhicasarId, organizationId, 'LEFT', {});
    return { left: true };
  },

  /** Customer-controlled presentation state for their business list (§1). */
  async setPreferences(
    vhicasarId: string,
    organizationId: string,
    prefs: { isPinned?: boolean; isHidden?: boolean; isFavourite?: boolean }
  ) {
    const link = await prismaUnscoped.customerLink.findUnique({
      where: { vhicasarId_organizationId: { vhicasarId, organizationId } },
    });
    if (!link) throw new NotFoundError('Business membership');
    return prismaUnscoped.customerLink.update({
      where: { id: link.id },
      data: {
        ...(prefs.isPinned !== undefined ? { isPinned: prefs.isPinned } : {}),
        ...(prefs.isHidden !== undefined ? { isHidden: prefs.isHidden } : {}),
        ...(prefs.isFavourite !== undefined ? { isFavourite: prefs.isFavourite } : {}),
      },
    });
  },

  /** Mark a business as the one the customer is currently looking at. */
  async touch(vhicasarId: string, organizationId: string) {
    await prismaUnscoped.customerLink.updateMany({
      where: { vhicasarId, organizationId, status: 'ACTIVE' },
      data: { lastAccessedAt: new Date() },
    });
  },

  async recordHistory(
    vhicasarId: string,
    organizationId: string,
    action: string,
    opts: { source?: string; qrCode?: string; campaignId?: string; referrerCustomerId?: string }
  ) {
    await prismaUnscoped.customerBusinessHistory.create({
      data: {
        vhicasarId,
        organizationId,
        action,
        source: opts.source ?? null,
        qrCode: opts.qrCode ?? null,
        metadata: {
          ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
          ...(opts.referrerCustomerId ? { referrerCustomerId: opts.referrerCustomerId } : {}),
        },
      },
    });
  },

  // ---- Business QR codes (§3) ----

  /** Merchant side: mint a scannable code. */
  async createQr(
    organizationId: string,
    dto: {
      kind: BusinessQrKind;
      label?: string;
      branchId?: string;
      campaignId?: string;
      referrerCustomerId?: string;
      expiresAt?: Date;
      maxScans?: number;
    }
  ) {
    const code = `VB${randomBytes(9).toString('base64url')}`;
    const signature = qrSignature(code, organizationId, dto.kind, dto.expiresAt?.getTime() ?? null);

    const qr = await prisma.businessQr.create({
      data: {
        organizationId,
        branchId: dto.branchId ?? null,
        kind: dto.kind,
        code,
        signature,
        label: dto.label ?? null,
        campaignId: dto.campaignId ?? null,
        referrerCustomerId: dto.referrerCustomerId ?? null,
        expiresAt: dto.expiresAt ?? null,
        maxScans: dto.maxScans ?? null,
      },
    });

    await auditService.record({
      action: 'business_qr.created',
      entityType: 'BusinessQr',
      entityId: qr.id,
      after: { kind: dto.kind, label: dto.label },
    });
    return { ...qr, payload: `vhicasar://join?c=${qr.code}` };
  },

  async listQrs(organizationId: string) {
    const rows = await prisma.businessQr.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((q) => ({ ...q, payload: `vhicasar://join?c=${q.code}` }));
  },

  async revokeQr(id: string) {
    const updated = await prisma.businessQr.updateMany({ where: { id }, data: { isActive: false } });
    if (updated.count === 0) throw new NotFoundError('QR code');
  },

  /**
   * Customer side: validate a scanned code and join. Every check the spec
   * lists is enforced *before* any association happens.
   */
  async joinByQr(vhicasarId: string, rawCode: string) {
    // Accept the deep link or the bare code.
    const code = rawCode.includes('c=') ? (new URL(rawCode.replace('vhicasar://', 'https://x/')).searchParams.get('c') ?? rawCode) : rawCode.trim();

    const qr = await prismaUnscoped.businessQr.findUnique({ where: { code } });
    if (!qr) throw new NotFoundError('QR code');
    if (!verifyQrSignature(qr)) {
      throw new AppError('QR_INVALID', 400, 'This code failed its integrity check.');
    }
    if (!qr.isActive) throw new AppError('QR_REVOKED', 409, 'This code is no longer active.');
    if (qr.expiresAt && qr.expiresAt.getTime() < Date.now()) {
      throw new AppError('QR_EXPIRED', 409, 'This code has expired.');
    }
    if (qr.maxScans !== null && qr.scanCount >= qr.maxScans) {
      throw new AppError('QR_EXHAUSTED', 409, 'This code has reached its scan limit.');
    }

    const org = await prismaUnscoped.organization.findFirst({
      where: { id: qr.organizationId, deletedAt: null },
      select: { status: true },
    });
    if (!org || !['ACTIVE', 'TRIAL'].includes(org.status)) {
      throw new AppError('BUSINESS_INACTIVE', 409, 'This business is not currently active.');
    }
    if (qr.branchId) {
      const branch = await prismaUnscoped.branch.findFirst({
        where: { id: qr.branchId, deletedAt: null },
        select: { isActive: true },
      });
      if (!branch?.isActive) throw new AppError('BRANCH_INACTIVE', 409, 'This branch is not currently active.');
    }

    const result = await this.join(vhicasarId, qr.organizationId, {
      source: qr.kind === 'REFERRAL' ? 'REFERRAL' : 'QR',
      qrCode: qr.code,
      campaignId: qr.campaignId ?? undefined,
      referrerCustomerId: qr.referrerCustomerId ?? undefined,
    });

    // Record the scan for the QR Center's conversion reporting (§6). This also
    // increments scanCount and joinCount, so there is exactly one place that
    // moves those counters. Imported lazily to avoid a cycle back to qr-center.
    const { recordQrScan } = await import('./qr-center.service');
    await recordQrScan({
      businessQrId: qr.id,
      organizationId: qr.organizationId,
      vhicasarId,
      didJoin: true,
    });

    return { ...result, organizationId: qr.organizationId, qrKind: qr.kind };
  },
};
