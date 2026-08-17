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
import { platformMonitoringService, platformAdminService } from '../../../application/monitoring/platform-monitoring.service';
import { kycService } from '../../../application/identity/kyc.service';
import { reviewKycSchema } from '../../../application/identity/identity.dto';
import { rewardCampaigns } from '../../../application/rewards/reward-campaign.service';
import { walletBuckets } from '../../../application/payments/wallet-buckets.service';

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
 * Manually verify and activate an organisation.
 *
 * For the case support actually hits: a business signed up, the verification
 * email never arrived — wrong address, a spam filter, a dead mailbox — and they
 * cannot get in. The operator confirms who they are out of band and lets them
 * through, rather than the business being stuck behind an email nobody can
 * resend to a working inbox.
 *
 * Deliberately narrow. It marks members' email addresses verified and puts the
 * organisation back to ACTIVE; it does not touch passwords, roles or anything
 * a support agent should never be able to change. Suspended and deleted users
 * are skipped — being unable to receive an email is not a reason to reinstate
 * someone who was suspended on purpose.
 */
serviceRoutes.post(
  '/organizations/:id/activate',
  validate({
    body: z.object({
      /** Who asked for this and why — recorded on both sides. */
      reason: z.string().trim().min(3).max(500),
      performedBy: z.string().trim().max(160).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const id = req.params.id as string;
    const organization = await prismaUnscoped.organization.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, name: true, status: true,
        memberships: {
          where: { deletedAt: null },
          select: {
            isActive: true,
            user: { select: { id: true, email: true, status: true, emailVerifiedAt: true, deletedAt: true } },
          },
        },
      },
    });
    if (!organization) throw new NotFoundError('Organization');

    // Someone suspended on purpose stays suspended.
    const eligible = organization.memberships
      .filter((m) => m.isActive && !m.user.deletedAt && m.user.status !== 'SUSPENDED')
      .map((m) => m.user);
    const unverified = eligible.filter((u) => !u.emailVerifiedAt);

    /*
     * Only lift a status that actually blocks sign-in.
     *
     * Login refuses SUSPENDED and CANCELLED organisations; TRIAL signs in
     * perfectly well. Forcing everything to ACTIVE would quietly end a trial
     * and misstate the business's billing state to fix an email problem.
     */
    const blocking: string[] = ['SUSPENDED', 'CANCELLED'];
    const liftStatus = blocking.includes(organization.status);

    const verifiedAt = new Date();
    const [, updatedOrg] = await prismaUnscoped.$transaction([
      prismaUnscoped.user.updateMany({
        where: { id: { in: unverified.map((u) => u.id) } },
        data: { emailVerifiedAt: verifiedAt },
      }),
      prismaUnscoped.organization.update({
        where: { id },
        data: liftStatus ? { status: 'ACTIVE' } : {},
        select: { id: true, name: true, status: true, updatedAt: true },
      }),
    ]);

    logger.info(
      {
        organizationId: id,
        previousStatus: organization.status,
        verifiedUsers: unverified.length,
        performedBy: req.body.performedBy ?? 'admin',
      },
      'service API: organization manually verified and activated',
    );

    /*
     * Recorded in the business's own audit log, not only in the admin's.
     *
     * Bypassing email verification is exactly the kind of action that has to be
     * answerable from the affected account's own history — an operator letting
     * someone in should be visible to the business, not just to the platform.
     */
    await prismaUnscoped.auditLog
      .create({
        data: {
          organizationId: id,
          actorType: 'SYSTEM',
          action: 'organization.manual_activation',
          entityType: 'Organization',
          entityId: id,
          before: { status: organization.status, unverifiedMembers: unverified.length },
          after: {
            status: updatedOrg.status,
            unverifiedMembers: 0,
            // The whole point of requiring a reason is that it survives.
            reason: req.body.reason,
            performedBy: req.body.performedBy ?? 'Vhicasar admin',
            verifiedEmails: unverified.map((u) => u.email),
          },
        },
      })
      .catch((error: unknown) =>
        logger.warn({ error, organizationId: id }, 'manual activation not written to the audit log'),
      );

    res.json({
      success: true,
      data: {
        organization: updatedOrg,
        previousStatus: organization.status,
        statusChanged: liftStatus,
        verifiedUsers: unverified.map((u) => u.email),
        alreadyVerified: eligible.length - unverified.length,
        skipped: organization.memberships.length - eligible.length,
      },
    });
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

// ── Platform monitoring for the Super Admin (cross-tenant, key-gated) ──────

/** Payment + fraud KPIs across all organisations (Fraud Center / dashboard). */
serviceRoutes.get(
  '/monitoring/overview',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await platformMonitoringService.overview() });
  }),
);

/** Cross-tenant fraud-alert queue. */
serviceRoutes.get(
  '/monitoring/fraud/alerts',
  validate({
    query: z.object({
      status: z.enum(['OPEN', 'REVIEWING', 'CONFIRMED', 'DISMISSED']).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { status?: string; cursor?: string; limit: number };
    res.json({ success: true, data: await platformMonitoringService.fraudAlerts(q) });
  }),
);

serviceRoutes.post(
  '/monitoring/fraud/alerts/:id/resolve',
  validate({ body: z.object({ action: z.enum(['CONFIRMED', 'DISMISSED']), resolution: z.string().trim().max(500).optional() }) }),
  wrap(async (req, res) => {
    const data = await platformMonitoringService.resolveAlert(req.params.id as string, req.body.action, req.body.resolution);
    res.json({ success: true, data });
  }),
);

// ── AI monitoring, compliance, feature flags, support (System Bible II §3) ─

serviceRoutes.get(
  '/monitoring/ai',
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  wrap(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    res.json({ success: true, data: await platformAdminService.aiMonitoring(days) });
  }),
);

serviceRoutes.get(
  '/monitoring/compliance',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await platformAdminService.complianceSummary() });
  }),
);

serviceRoutes.get(
  '/monitoring/billing',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await platformAdminService.billingMonitoring() });
  }),
);

serviceRoutes.get(
  '/monitoring/events',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await platformAdminService.eventHealth() });
  }),
);

/** Vhicasar Pay adoption and usage across the platform. */
serviceRoutes.get(
  '/monitoring/pay-usage',
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  wrap(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    res.json({ success: true, data: await platformAdminService.payUsage(days) });
  }),
);

/** Settlement oversight for the Super Admin (§13). */
serviceRoutes.get(
  '/monitoring/settlements',
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }) }),
  wrap(async (req, res) => {
    const { limit } = req.query as unknown as { limit: number };
    res.json({ success: true, data: await platformAdminService.settlementOversight({ limit }) });
  }),
);

serviceRoutes.get(
  '/monitoring/audit',
  validate({
    query: z.object({
      action: z.string().trim().max(80).optional(),
      organizationId: z.string().trim().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { action?: string; organizationId?: string; cursor?: string; limit: number };
    res.json({ success: true, data: await platformAdminService.auditTrail(q) });
  }),
);

// Feature flags
serviceRoutes.get('/feature-flags', wrap(async (_req, res) => {
  res.json({ success: true, data: await platformAdminService.listFeatureFlags() });
}));

serviceRoutes.put(
  '/feature-flags',
  validate({
    body: z.object({
      key: z.string().trim().min(2).max(80),
      description: z.string().trim().max(300).optional(),
      isEnabled: z.boolean(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await platformAdminService.upsertFeatureFlag(req.body) });
  }),
);

serviceRoutes.put(
  '/feature-flags/:key/overrides',
  validate({
    body: z.object({ organizationId: z.string().trim().min(1), isEnabled: z.boolean() }),
  }),
  wrap(async (req, res) => {
    const data = await platformAdminService.setFeatureFlagOverride(
      req.params.key as string,
      req.body.organizationId,
      req.body.isEnabled,
    );
    res.json({ success: true, data });
  }),
);

// Support tools
serviceRoutes.get(
  '/support/identity',
  validate({ query: z.object({ q: z.string().trim().min(3).max(80) }) }),
  wrap(async (req, res) => {
    const { q } = req.query as unknown as { q: string };
    res.json({ success: true, data: await platformAdminService.lookupIdentity(q) });
  }),
);

serviceRoutes.post(
  '/support/identity/:id/status',
  validate({
    body: z.object({
      status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
      reason: z.string().trim().max(300).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await platformAdminService.setIdentityStatus(
      req.params.id as string,
      req.body.status,
      req.body.reason,
    );
    res.json({ success: true, data });
  }),
);

// ── Reward campaigns (§11, §13) ───────────────────────────────────────────

serviceRoutes.get('/reward-campaigns', wrap(async (_req, res) => {
  res.json({ success: true, data: await rewardCampaigns.list() });
}));

serviceRoutes.put(
  '/reward-campaigns',
  validate({
    body: z.object({
      id: z.string().trim().optional(),
      name: z.string().trim().min(2).max(140),
      description: z.string().trim().max(2000).optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'SUSPENDED']).optional(),
      rewardAmount: z.coerce.number().positive().optional(),
      rewardPercent: z.coerce.number().positive().max(100).optional(),
      maxRewardPerTxn: z.coerce.number().positive().optional(),
      minSpend: z.coerce.number().nonnegative().optional(),
      maxRewardsPerDay: z.coerce.number().int().positive().optional(),
      maxRewardsPerMonth: z.coerce.number().int().positive().optional(),
      budget: z.coerce.number().positive().optional(),
      currency: z.string().trim().length(3),
      eligibleOrganizationIds: z.array(z.string()).optional(),
      eligibleCategories: z.array(z.string()).optional(),
      eligibleCountries: z.array(z.string()).optional(),
      targetBucket: z.enum(['REWARD', 'CASHBACK', 'AVAILABLE']).optional(),
      rewardExpiryDays: z.coerce.number().int().positive().optional(),
      fundingSource: z.enum(['PLATFORM', 'MERCHANT', 'SHARED']).optional(),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await rewardCampaigns.upsert(req.body) });
  }),
);

serviceRoutes.post(
  '/reward-campaigns/:id/status',
  validate({ body: z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'SUSPENDED']) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await rewardCampaigns.setStatus(req.params.id as string, req.body.status) });
  }),
);

serviceRoutes.get(
  '/reward-campaigns/analytics',
  validate({ query: z.object({ campaignId: z.string().trim().optional() }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await rewardCampaigns.analytics(req.query.campaignId as string | undefined) });
  }),
);

/** Rewards held by the abuse checks, awaiting a human decision (§15). */
serviceRoutes.get('/reward-grants/pending', wrap(async (_req, res) => {
  res.json({ success: true, data: await rewardCampaigns.pendingReviews() });
}));

serviceRoutes.post(
  '/reward-grants/:id/review',
  validate({ body: z.object({ action: z.enum(['APPROVE', 'REJECT']), notes: z.string().trim().max(500).optional() }) }),
  wrap(async (req, res) => {
    const data = await rewardCampaigns.reviewGrant(req.params.id as string, req.body.action, req.body.notes);
    res.json({ success: true, data });
  }),
);

/** Support release of locked funds (account closure, dispute, error). */
serviceRoutes.post(
  '/support/identity/:id/release-locked',
  validate({
    body: z.object({
      amount: z.coerce.number().positive(),
      currency: z.string().trim().length(3),
      reason: z.string().trim().min(3).max(300),
    }),
  }),
  wrap(async (req, res) => {
    const data = await walletBuckets.releaseLockedFunds(
      req.params.id as string,
      req.body.amount,
      req.body.currency,
      req.body.reason,
    );
    res.json({ success: true, data });
  }),
);

// ── KYC review queue (platform admin) ────────────────────────────────────

serviceRoutes.get(
  '/kyc/submissions',
  validate({
    query: z.object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { status?: string; cursor?: string; limit: number };
    res.json({ success: true, data: await kycService.listPending(q) });
  }),
);

serviceRoutes.post(
  '/kyc/submissions/:id/review',
  validate({ body: reviewKycSchema }),
  wrap(async (req, res) => {
    const data = await kycService.review(req.params.id as string, req.body, 'PLATFORM_ADMIN');
    res.json({ success: true, data });
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

// ---- Payments oversight (§18) ----

/**
 * Provider capabilities: what each gateway may be used for, platform-wide.
 *
 * The ceiling under which businesses choose. An operator can withdraw a method
 * from a provider — a gateway suspending USSD, say — without a deploy, and
 * every business collecting through it stops offering it immediately.
 *
 * The one thing this cannot do is turn a method *on* for a business that has
 * switched it off. That direction is deliberate (§18): the hierarchy only ever
 * subtracts as it goes down.
 */
serviceRoutes.get(
  '/payments/capabilities',
  wrap(async (_req, res) => {
    const { PROVIDER_CAPABILITIES, PLATFORM_NATIVE_METHODS } = await import(
      '../../../infrastructure/payments/capabilities'
    );
    const overrides = await prismaUnscoped.providerCapability.findMany({
      orderBy: [{ provider: 'asc' }, { method: 'asc' }],
    });
    res.json({
      success: true,
      data: {
        shipped: PROVIDER_CAPABILITIES,
        platformNative: PLATFORM_NATIVE_METHODS,
        overrides,
      },
    });
  })
);

serviceRoutes.put(
  '/payments/capabilities',
  validate({
    body: z.object({
      provider: z.string().trim().min(2).max(40),
      method: z.string().trim().min(2).max(40),
      enabled: z.boolean(),
      currencies: z.array(z.string().trim().length(3)).max(30).optional(),
      countries: z.array(z.string().trim().length(2)).max(60).optional(),
      minAmount: z.number().nonnegative().optional(),
      maxAmount: z.number().positive().optional(),
      notes: z.string().trim().max(300).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const b = req.body as {
      provider: string; method: string; enabled: boolean;
      currencies?: string[]; countries?: string[];
      minAmount?: number; maxAmount?: number; notes?: string;
    };
    const data = {
      enabled: b.enabled,
      currencies: (b.currencies ?? []).map((c) => c.toUpperCase()),
      countries: (b.countries ?? []).map((c) => c.toUpperCase()),
      minAmount: b.minAmount ?? null,
      maxAmount: b.maxAmount ?? null,
      notes: b.notes ?? null,
    };
    const saved = await prismaUnscoped.providerCapability.upsert({
      where: { provider_method: { provider: b.provider, method: b.method as never } },
      create: { provider: b.provider, method: b.method as never, ...data },
      update: data,
    });
    res.json({ success: true, data: saved });
  })
);

/** Inbound webhook log, newest first — including the ones that failed. */
serviceRoutes.get(
  '/payments/webhooks',
  validate({
    query: z.object({
      status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED']).optional(),
      provider: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { status?: string; provider?: string; limit: number };
    const rows = await prismaUnscoped.inboundWebhookEvent.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.provider ? { provider: q.provider } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: q.limit,
    });
    res.json({ success: true, data: rows });
  })
);

/** Push the failed queue through again, on demand. */
serviceRoutes.post(
  '/payments/webhooks/retry',
  wrap(async (_req, res) => {
    const { paymentWebhookService } = await import(
      '../../../application/payments/payment-webhook.service'
    );
    res.json({ success: true, data: await paymentWebhookService.retryFailed(100) });
  })
);

/** Run reconciliation now rather than waiting for the sweep. */
serviceRoutes.post(
  '/payments/reconcile',
  wrap(async (_req, res) => {
    const { reconcilePayments } = await import(
      '../../../application/payments/payment-reconciliation.service'
    );
    res.json({ success: true, data: await reconcilePayments({ olderThanMinutes: 0 }) });
  })
);

/** Payment intents across every business, for support and investigation. */
serviceRoutes.get(
  '/payments/intents',
  validate({
    query: z.object({
      status: z.string().optional(),
      organizationId: z.string().optional(),
      reference: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as Record<string, string> & { limit: number };
    const rows = await prismaUnscoped.paymentIntent.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.organizationId ? { organizationId: q.organizationId } : {}),
        ...(q.reference ? { reference: q.reference.toUpperCase() } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    res.json({ success: true, data: rows });
  })
);

// ---- AI usage, credit and balance ----

/**
 * Platform-wide AI consumption.
 *
 * The plan quota only ever counted *responses*, which says nothing about cost:
 * a one-line reply and a long summary counted the same. This reports tokens,
 * and breaks them down by provider, by feature and by business, so an operator
 * can see where the spend actually goes.
 */
serviceRoutes.get(
  '/ai/usage',
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  wrap(async (req, res) => {
    const { aiUsageService } = await import('../../../application/ai/ai-usage.service');
    const days = Number((req.query as { days?: number }).days ?? 30);
    res.json({ success: true, data: await aiUsageService.platformSummary(days) });
  })
);

/** Where one organisation stands: allowance, grants, consumption, remaining. */
serviceRoutes.get(
  '/ai/usage/:organizationId',
  wrap(async (req, res) => {
    const { aiUsageService } = await import('../../../application/ai/ai-usage.service');
    const organizationId = req.params.organizationId as string;
    const [balance, grants, recent] = await Promise.all([
      aiUsageService.balance(organizationId),
      aiUsageService.grantsFor(organizationId),
      prismaUnscoped.aiUsageEvent.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, provider: true, model: true, feature: true,
          promptTokens: true, completionTokens: true, totalTokens: true,
          credits: true, ownKey: true, failed: true, createdAt: true,
        },
      }),
    ]);
    res.json({ success: true, data: { balance, grants, recent } });
  })
);

/**
 * Adjust an organisation's AI credit.
 *
 * Recorded as a grant rather than by overwriting a number: "why does this
 * business have five thousand extra credits?" is a question that gets asked,
 * and a single figure cannot answer it. A negative value claws credit back.
 */
serviceRoutes.post(
  '/ai/usage/:organizationId/grant',
  validate({
    body: z.object({
      credits: z.number().int().refine((n) => n !== 0, 'A grant of zero changes nothing'),
      reason: z.string().trim().min(3).max(300),
      expiresAt: z.string().datetime().optional(),
      grantedById: z.string().trim().max(60).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const { aiUsageService } = await import('../../../application/ai/ai-usage.service');
    const body = req.body as {
      credits: number; reason: string; expiresAt?: string; grantedById?: string;
    };
    const organizationId = req.params.organizationId as string;

    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) throw new NotFoundError('Organization');

    await aiUsageService.grant({
      organizationId,
      credits: body.credits,
      reason: body.reason,
      grantedById: body.grantedById ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });

    res.status(201).json({
      success: true,
      message:
        body.credits > 0
          ? `Granted ${body.credits} AI credits.`
          : `Removed ${Math.abs(body.credits)} AI credits.`,
      data: await aiUsageService.balance(organizationId),
    });
  })
);
