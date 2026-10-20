import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { normalizePhone } from '../sms/phone-numbers';

/**
 * Who a campaign may be sent to, on any channel.
 *
 * Two things decide that, and they are deliberately kept apart. A *segment*
 * answers "which customers is this campaign about" from the business's own CRM
 * and order history, and knows nothing about channels. *Eligibility* answers
 * "may we message this person here", which is where the channel comes in: an
 * email campaign needs an address, a WhatsApp or SMS campaign needs a usable
 * number.
 *
 * Eligibility is applied after the segment, every time, including immediately
 * before dispatch — consent withdrawn an hour ago has to be honoured by a
 * campaign starting now.
 *
 * A previous purchase is not consent. Nothing here infers permission from the
 * existence of an order or a CRM record; `marketingOptIn` is the only thing
 * that grants it.
 */

/** The channels a segment can be resolved for. */
export type AudienceChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

/** What counts as a purchase, stated once so every segment agrees. */
const COMPLETED_ORDER = {
  status: { in: ['DELIVERED', 'COMPLETED'] as const },
  paymentStatus: { in: ['PAID', 'PARTIALLY_PAID'] as const },
} satisfies Prisma.OrderWhereInput;

/*
 * Refunds are excluded by the status filter above rather than by subtracting
 * them afterwards: an order that was refunded is REFUNDED, so it never enters
 * the totals and cannot be double-counted out of them.
 */

export const SEGMENT_KINDS = [
  'ALL_ELIGIBLE',
  'FIRST_TIME',
  'NEVER_PURCHASED',
  'MOST_VALUABLE',
  'REPEAT',
  'INACTIVE',
  'CUSTOM',
] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const segmentSchema = z.object({
  kind: z.enum(SEGMENT_KINDS),
  /** FIRST_TIME: first purchase within this many days. */
  withinDays: z.number().int().min(1).max(3650).optional(),
  /** INACTIVE: no purchase for at least this many days. */
  inactiveDays: z.number().int().min(1).max(3650).optional(),
  /** MOST_VALUABLE: how many of the top spenders to take. */
  topCount: z.number().int().min(1).max(5000).optional(),
  /** REPEAT: at least this many completed purchases. */
  minOrders: z.number().int().min(2).max(1000).optional(),
  /** CUSTOM: any combination of the supported filters. */
  custom: z.object({
    minSpend: z.number().min(0).optional(),
    maxSpend: z.number().min(0).optional(),
    minOrders: z.number().int().min(0).optional(),
    purchasedAfter: z.string().datetime().optional(),
    purchasedBefore: z.string().datetime().optional(),
    createdAfter: z.string().datetime().optional(),
    tags: z.array(z.string().trim().max(60)).max(20).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'CUSTOM' && !value.custom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['custom'], message: 'Describe at least one filter for a custom segment' });
  }
});
export type SegmentDefinition = z.infer<typeof segmentSchema>;

export interface AudienceMember {
  customerId: string;
  firstName: string | null;
  lastName: string | null;
  /**
   * Where the message goes, in the form the channel wants it: an email
   * address, or a number in E.164 without the leading plus, which is what
   * Meta and the SMS providers both expect.
   */
  address: string;
  /** The same value under its WhatsApp name, for callers that read waId. */
  waId: string;
  orderCount: number;
  totalSpend: number;
}

export interface AudienceSummary {
  members: AudienceMember[];
  /** Everyone the segment matched, before eligibility was applied. */
  matched: number;
  excluded: {
    optedOut: number;
    /** No address at all for this channel. */
    noPhone: number;
    /** An address this channel cannot use. */
    unusablePhone: number;
    blocked: number;
    duplicate: number;
  };
}

/** Tags live in the customer's free-form fields rather than a column. */
function customerTags(customFields: unknown): string[] {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return [];
  const tags = (customFields as { tags?: unknown }).tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

const DAY = 24 * 60 * 60 * 1000;
const since = (days: number) => new Date(Date.now() - days * DAY);

/** Per-customer purchase totals, counted once from completed orders only. */
async function purchaseTotals(organizationId: string) {
  const rows = await prismaUnscoped.order.groupBy({
    by: ['customerId'],
    where: { organizationId, ...COMPLETED_ORDER },
    _count: { _all: true },
    _sum: { total: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
  });
  return new Map(rows.map((row) => [row.customerId, {
    orders: row._count._all,
    spend: Number(row._sum.total ?? 0),
    firstAt: row._min.createdAt,
    lastAt: row._max.createdAt,
  }]));
}

/**
 * Customers the segment describes — before any eligibility rule is applied.
 *
 * Kept separate so the summary can report honestly how many people the
 * segment found and how many of those could actually be messaged.
 */
async function matchSegment(organizationId: string, definition: SegmentDefinition): Promise<string[]> {
  const totals = await purchaseTotals(organizationId);
  /*
   * Scoped by organizationId explicitly, not by ambient request context.
   *
   * This function takes the tenant as an argument, and a campaign dispatch
   * runs in a worker where that context may be absent or belong to a
   * different job. Relying on the scoped client here pulled in every
   * business's customers — orders were already filtered explicitly, so the
   * two halves disagreed about who the audience was.
   */
  const customers = await prismaUnscoped.customer.findMany({
    where: { organizationId, deletedAt: null, isProvisional: false },
    select: { id: true, createdAt: true, customFields: true },
  });

  const withTotals = customers.map((customer) => ({
    id: customer.id,
    createdAt: customer.createdAt,
    tags: customerTags(customer.customFields),
    ...(totals.get(customer.id) ?? { orders: 0, spend: 0, firstAt: null as Date | null, lastAt: null as Date | null }),
  }));

  switch (definition.kind) {
    case 'ALL_ELIGIBLE':
      return withTotals.map((c) => c.id);

    case 'FIRST_TIME': {
      const cutoff = since(definition.withinDays ?? 30);
      return withTotals.filter((c) => c.firstAt && c.firstAt >= cutoff).map((c) => c.id);
    }

    case 'NEVER_PURCHASED':
      return withTotals.filter((c) => c.orders === 0).map((c) => c.id);

    case 'REPEAT': {
      const minimum = definition.minOrders ?? 2;
      return withTotals.filter((c) => c.orders >= minimum).map((c) => c.id);
    }

    case 'MOST_VALUABLE':
      return withTotals
        .filter((c) => c.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, definition.topCount ?? 100)
        .map((c) => c.id);

    case 'INACTIVE': {
      const cutoff = since(definition.inactiveDays ?? 90);
      // Someone who never bought has not "gone inactive" — they are a
      // different segment, and lumping them together overstates churn.
      return withTotals.filter((c) => c.orders > 0 && c.lastAt && c.lastAt < cutoff).map((c) => c.id);
    }

    case 'CUSTOM': {
      const filter = definition.custom ?? {};
      return withTotals.filter((c) => {
        if (filter.minSpend !== undefined && c.spend < filter.minSpend) return false;
        if (filter.maxSpend !== undefined && c.spend > filter.maxSpend) return false;
        if (filter.minOrders !== undefined && c.orders < filter.minOrders) return false;
        if (filter.purchasedAfter && !(c.lastAt && c.lastAt >= new Date(filter.purchasedAfter))) return false;
        if (filter.purchasedBefore && !(c.firstAt && c.firstAt <= new Date(filter.purchasedBefore))) return false;
        if (filter.createdAfter && c.createdAt < new Date(filter.createdAfter)) return false;
        if (filter.tags?.length && !filter.tags.some((tag) => c.tags.includes(tag))) return false;
        return true;
      }).map((c) => c.id);
    }

    default:
      return [];
  }
}

export const audienceService = {
  /**
   * Resolve a segment into the people who can actually be messaged.
   *
   * Call it to preview an audience and call it again before dispatching: the
   * second call is what keeps an opt-out that arrived in between from being
   * ignored.
   */
  async resolve(
    organizationId: string,
    definition: SegmentDefinition,
    channel: AudienceChannel = 'WHATSAPP',
    limit = 5000,
  ): Promise<AudienceSummary> {
    const matchedIds = await matchSegment(organizationId, definition);
    const excluded = { optedOut: 0, noPhone: 0, unusablePhone: 0, blocked: 0, duplicate: 0 };
    if (matchedIds.length === 0) return { members: [], matched: 0, excluded };

    const totals = await purchaseTotals(organizationId);
    const customers = await prismaUnscoped.customer.findMany({
      where: { id: { in: matchedIds }, organizationId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, phone: true, email: true, marketingOptIn: true, isBlocked: true },
    });

    const seen = new Set<string>();
    const members: AudienceMember[] = [];
    for (const customer of customers) {
      if (customer.isBlocked) { excluded.blocked += 1; continue; }
      // Consent is explicit or it does not exist. A purchase is not consent.
      if (!customer.marketingOptIn) { excluded.optedOut += 1; continue; }

      let address: string | null = null;
      if (channel === 'EMAIL') {
        if (!customer.email) { excluded.noPhone += 1; continue; }
        const trimmed = customer.email.trim().toLowerCase();
        // Enough to reject what cannot be delivered; the provider judges the rest.
        if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(trimmed)) { excluded.unusablePhone += 1; continue; }
        address = trimmed;
      } else {
        if (!customer.phone) { excluded.noPhone += 1; continue; }
        const { e164 } = normalizePhone(customer.phone);
        if (!e164) { excluded.unusablePhone += 1; continue; }
        // Meta and the SMS providers both address without the leading plus.
        address = e164.replace(/^\+/, '');
      }

      // Two CRM records sharing an address must not both be messaged.
      if (seen.has(address)) { excluded.duplicate += 1; continue; }
      seen.add(address);
      const total = totals.get(customer.id);
      members.push({
        customerId: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        address,
        waId: address,
        orderCount: total?.orders ?? 0,
        totalSpend: total?.spend ?? 0,
      });
      if (members.length >= limit) break;
    }
    return { members, matched: matchedIds.length, excluded };
  },

  /** Still eligible right now? Used to re-check a recipient at dispatch. */
  async stillEligible(organizationId: string, customerId: string): Promise<boolean> {
    const customer = await prismaUnscoped.customer.findFirst({
      where: { id: customerId, organizationId, deletedAt: null },
      select: { marketingOptIn: true, isBlocked: true, phone: true },
    });
    return Boolean(customer?.marketingOptIn && !customer.isBlocked && customer.phone);
  },
};


/** The previous name, kept so the WhatsApp paths read as they did. */
export const whatsappAudienceService = audienceService;
