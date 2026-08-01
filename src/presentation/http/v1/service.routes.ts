import { timingSafeEqual } from 'crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { env } from '../../../shared/config/env';
import { logger } from '../../../shared/logger';
import { ForbiddenError, NotFoundError } from '../../../shared/errors';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { domainConfigSchema, domainConfigService } from '../../../application/sites/domain-config.service';
import { getActivePaymentProvider } from '../../../infrastructure/payments';
import { mailer } from '../../../infrastructure/mail/mailer';

/**
 * Service API — for the Vhicasar Admin, not for tenants or end users.
 *
 * Deliberately narrow: it exposes the organisation roster and explicit
 * lifecycle controls, not tenant business data. No customer records, messages,
 * or revenue detail beyond the current plan are exposed.
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
  deleted: z.enum(['exclude', 'only']).default('exclude'),
});

const organizationStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'TRIAL', 'SUSPENDED']),
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
        deletedAt: dto.deleted === 'only' ? { not: null } : null,
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
        id: true, name: true, slug: true, businessType: true, status: true, deletedAt: true,
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
        deletedAt: o.deletedAt,
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

/** Suspend/reactivate an organisation without destroying its data. */
serviceRoutes.patch(
  '/organizations/:id/status',
  validate({ body: organizationStatusSchema }),
  wrap(async (req, res) => {
    const id = req.params.id as string;
    const existing = await prismaUnscoped.organization.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, name: true,
        memberships: {
          where: { deletedAt: null, isActive: true },
          select: { user: { select: { email: true } } },
        },
      },
    });
    if (!existing) throw new NotFoundError('Organization');

    const organization = await prismaUnscoped.organization.update({
      where: { id },
      data: { status: req.body.status },
      select: { id: true, name: true, status: true, updatedAt: true },
    });
    logger.info({ organizationId: id, status: organization.status }, 'service API: organization status changed');
    const suspended = organization.status === 'SUSPENDED';
    await Promise.all(existing.memberships.map(({ user }) => mailer.sendNotice(
      user.email,
      suspended ? `${existing.name} has been suspended` : `${existing.name} has been reactivated`,
      suspended ? 'Organisation suspended' : 'Organisation reactivated',
      suspended
        ? `<p>Your organisation <b>${existing.name}</b> has been suspended by the platform administrator. Access is currently unavailable. Contact support if you believe this is an error.</p>`
        : `<p>Your organisation <b>${existing.name}</b> has been reactivated. You can sign in and continue using Vhicasar Hub AI.</p>`,
      suspended
        ? `${existing.name} has been suspended. Access is unavailable until it is reactivated.`
        : `${existing.name} has been reactivated. You can access Vhicasar Hub AI again.`,
      { organizationId: id },
    ))).catch((error) => logger.warn({ error, organizationId: id }, 'organization status email failed'));
    res.json({ success: true, data: organization });
  }),
);

/**
 * Soft-delete an organisation. Memberships are disabled and billable
 * subscriptions cancelled, while tenant data remains recoverable in storage.
 */
serviceRoutes.delete(
  '/organizations/:id',
  wrap(async (req, res) => {
    const id = req.params.id as string;
    const existing = await prismaUnscoped.organization.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, name: true,
        memberships: {
          where: { deletedAt: null, isActive: true },
          select: { user: { select: { email: true } } },
        },
      },
    });
    if (!existing) throw new NotFoundError('Organization');

    const now = new Date();
    // Prevent another external renewal before changing local subscription
    // state. Gateway cancellation is best-effort, consistent with the normal
    // customer-initiated cancellation flow.
    const billable = await prismaUnscoped.subscription.findMany({
      where: { organizationId: id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      select: { provider: true, providerSubscriptionCode: true },
    });
    try {
      const provider = getActivePaymentProvider();
      await Promise.all(
        billable
          .filter((subscription) =>
            subscription.provider === provider.name && subscription.providerSubscriptionCode)
          .map((subscription) => provider.disableSubscription(subscription.providerSubscriptionCode!)),
      );
    } catch (error) {
      logger.warn({ error, organizationId: id }, 'service API: gateway subscription cancellation failed');
    }
    await prismaUnscoped.$transaction([
      prismaUnscoped.organization.update({
        where: { id },
        data: { status: 'CANCELLED', deletedAt: now },
      }),
      prismaUnscoped.membership.updateMany({
        where: { organizationId: id, deletedAt: null },
        data: { isActive: false, deletedAt: now },
      }),
      prismaUnscoped.subscription.updateMany({
        where: { organizationId: id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
        data: { status: 'CANCELLED', cancelAtPeriodEnd: false, cancelledAt: now },
      }),
    ]);
    logger.info({ organizationId: id, name: existing.name }, 'service API: organization soft-deleted');
    await Promise.all(existing.memberships.map(({ user }) => mailer.sendNotice(
      user.email,
      `${existing.name} has been deleted`,
      'Organisation deleted',
      `<p>Your organisation <b>${existing.name}</b> has been deleted by the platform administrator. Access has been disabled. Contact support if you believe this is an error.</p>`,
      `${existing.name} has been deleted and access has been disabled. Contact support if this was unexpected.`,
      { organizationId: id },
    ))).catch((error) => logger.warn({ error, organizationId: id }, 'organization deletion email failed'));
    res.json({ success: true, data: { deleted: true, id } });
  }),
);

/** Second-stage irreversible deletion of an already soft-deleted account. */
serviceRoutes.delete('/organizations/:id/permanent', wrap(async (req, res) => {
  const id = req.params.id as string;
  const existing = await prismaUnscoped.organization.findFirst({ where: { id, deletedAt: { not: null } } });
  if (!existing) throw new NotFoundError('Deleted organization');
  await prismaUnscoped.organization.delete({ where: { id } });
  logger.warn({ organizationId: id, name: existing.name }, 'service API: organization permanently deleted');
  res.json({ success: true, data: { permanentlyDeleted: true, id } });
}));

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
