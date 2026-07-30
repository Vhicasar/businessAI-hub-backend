import { timingSafeEqual } from 'crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { env } from '../../../shared/config/env';
import { logger } from '../../../shared/logger';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { domainConfigSchema, domainConfigService } from '../../../application/sites/domain-config.service';

/**
 * Service API — for the Vhicasar Admin, not for tenants or end users.
 *
 * Read-only, and deliberately narrow: it answers "who has onboarded onto this
 * deployment", not "show me their data". No customer records, no messages, no
 * revenue detail beyond the plan they're on. If the admin ever needs more, that
 * should be a new, equally explicit endpoint rather than a widening of this one.
 *
 * ── Why this is the only place we go cross-tenant on purpose ──────────────
 * Every other route in this app is scoped to one organisation. This one lists
 * all of them, so it does not use the tenant client at all — and it is gated by
 * a shared secret that must be configured before the routes even mount.
 */

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Constant-time compare so the key can't be guessed a byte at a time. */
function keyMatches(provided: string): boolean {
  const expected = env.service.apiKey;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const requireServiceKey: RequestHandler = (req, _res, next) => {
  const provided = req.header('x-service-key') ?? '';
  if (!provided || !keyMatches(provided)) {
    logger.warn({ ip: req.ip, path: req.path }, 'service API: rejected request');
    next(new ForbiddenError('Invalid service key'));
    return;
  }
  next();
};

export const serviceRoutes = Router();
serviceRoutes.use(requireServiceKey);

// Platform-admin domain deployment configuration. The external Vhicasar Admin
// uses these endpoints to add providers/domains and switch the active target.
serviceRoutes.get('/domain-configs', wrap(async (_req, res) => {
  res.json({ success: true, data: await domainConfigService.list() });
}));
serviceRoutes.post('/domain-configs', validate({ body: domainConfigSchema }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await domainConfigService.create(req.body) });
}));
serviceRoutes.patch('/domain-configs/:id', validate({ body: domainConfigSchema.partial() }), wrap(async (req, res) => {
  res.json({ success: true, data: await domainConfigService.update(req.params.id as string, req.body) });
}));
serviceRoutes.post('/domain-configs/:id/activate', wrap(async (req, res) => {
  res.json({ success: true, data: await domainConfigService.activate(req.params.id as string) });
}));
serviceRoutes.delete('/domain-configs/:id', wrap(async (req, res) => {
  res.json({ success: true, data: await domainConfigService.remove(req.params.id as string) });
}));

const listQuery = z.object({
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Onboarded organisations, newest first: who they are, who owns them, what
 * they're on, and how much they've actually set up.
 */
serviceRoutes.get(
  '/organizations',
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const dto = req.query as unknown as z.infer<typeof listQuery>;

    const rows = await prismaUnscoped.organization.findMany({
      where: {
        deletedAt: null,
        ...(dto.search
          ? {
              OR: [
                { name: { contains: dto.search, mode: 'insensitive' as const } },
                { email: { contains: dto.search, mode: 'insensitive' as const } },
                { slug: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: {
        id: true, name: true, slug: true, businessType: true, status: true,
        email: true, phone: true, country: true, currency: true, timezone: true,
        createdAt: true,
        memberships: {
          where: { isOwner: true, deletedAt: null },
          select: {
            createdAt: true,
            user: { select: { email: true, firstName: true, lastName: true, lastLoginAt: true } },
          },
          take: 1,
        },
        subscriptions: {
          where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            status: true, trialEndsAt: true, currentPeriodEnd: true,
            plan: { select: { name: true, slug: true } },
          },
        },
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > dto.limit;
    const page = hasMore ? rows.slice(0, dto.limit) : rows;

    // Customer and Order have no relation back to Organization, so these are
    // counted separately — grouped for the whole page rather than per row, to
    // keep this at two queries instead of 2N.
    const ids = page.map((o) => o.id);
    const [customerCounts, orderCounts] = await Promise.all([
      prismaUnscoped.customer.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      prismaUnscoped.order.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const countOf = (list: { organizationId: string; _count: { _all: number } }[], id: string) =>
      list.find((c) => c.organizationId === id)?._count._all ?? 0;

    const items = page.map((o) => {
      const owner = o.memberships[0];
      const sub = o.subscriptions[0];
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        businessType: o.businessType,
        status: o.status,
        email: o.email,
        phone: o.phone,
        country: o.country,
        currency: o.currency,
        timezone: o.timezone,
        signedUpAt: o.createdAt,
        owner: owner
          ? {
              name: `${owner.user.firstName} ${owner.user.lastName ?? ''}`.trim(),
              email: owner.user.email,
              lastLoginAt: owner.user.lastLoginAt,
            }
          : null,
        subscription: sub
          ? {
              plan: sub.plan.name,
              planSlug: sub.plan.slug,
              status: sub.status,
              trialEndsAt: sub.trialEndsAt,
              renewsAt: sub.currentPeriodEnd,
            }
          : null,
        // Enough to tell a real workspace from an abandoned signup.
        counts: {
          users: o._count.memberships,
          customers: countOf(customerCounts, o.id),
          orders: countOf(orderCounts, o.id),
        },
      };
    });

    res.json({
      success: true,
      data: { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null },
    });
  }),
);

/** One organisation, same shape as the list. */
serviceRoutes.get(
  '/organizations/:id',
  wrap(async (req, res) => {
    const org = await prismaUnscoped.organization.findFirst({
      where: { id: req.params.id as string, deletedAt: null },
      select: {
        id: true, name: true, slug: true, businessType: true, status: true,
        email: true, phone: true, country: true, currency: true, timezone: true, createdAt: true,
        memberships: {
          where: { deletedAt: null },
          select: {
            isOwner: true, isActive: true, createdAt: true,
            role: { select: { name: true } },
            user: { select: { email: true, firstName: true, lastName: true, lastLoginAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!org) throw new NotFoundError('Organization');

    const { memberships, ...rest } = org;
    res.json({
      success: true,
      data: {
        ...rest,
        signedUpAt: org.createdAt,
        team: memberships.map((m) => ({
          name: `${m.user.firstName} ${m.user.lastName ?? ''}`.trim(),
          email: m.user.email,
          role: m.role.name,
          isOwner: m.isOwner,
          isActive: m.isActive,
          lastLoginAt: m.user.lastLoginAt,
          joinedAt: m.createdAt,
        })),
      },
    });
  }),
);

/** Headline counts for the admin dashboard. */
serviceRoutes.get(
  '/stats',
  wrap(async (_req, res) => {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [total, recent, active, byStatus] = await Promise.all([
      prismaUnscoped.organization.count({ where: { deletedAt: null } }),
      prismaUnscoped.organization.count({ where: { deletedAt: null, createdAt: { gte: since } } }),
      prismaUnscoped.subscription.count({ where: { status: 'ACTIVE' } }),
      prismaUnscoped.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    res.json({
      success: true,
      data: {
        organizations: total,
        newLast30Days: recent,
        activeSubscriptions: active,
        subscriptionsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      },
    });
  }),
);
