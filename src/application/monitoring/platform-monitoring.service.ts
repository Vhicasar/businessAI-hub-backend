import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';
import { emitEvent } from '../../shared/domain-events';

/**
 * Platform-wide (cross-tenant) monitoring for the Super Admin Portal (System
 * Bible II §3 — Fraud Center, payment monitoring, compliance). Read via the
 * key-gated Service API only; uses the unscoped client on purpose, like the
 * rest of that surface. Never exposes tenant business detail beyond aggregates
 * and fraud signals.
 */
export const platformMonitoringService = {
  /** Headline payment + fraud KPIs across all organisations (last 30 days). */
  async overview() {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [payAgg, blocked, openAlerts, criticalAlerts, settleAgg, riskByDecision] = await Promise.all([
      prismaUnscoped.payment.aggregate({
        where: { provider: 'vhicasar_pay', status: 'PAID', createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prismaUnscoped.paymentAttempt.count({ where: { status: 'BLOCKED', createdAt: { gte: since } } }),
      prismaUnscoped.fraudAlert.count({ where: { status: 'OPEN' } }),
      prismaUnscoped.fraudAlert.count({ where: { status: 'OPEN', severity: 'CRITICAL' } }),
      prismaUnscoped.settlement.aggregate({ _count: { _all: true }, _sum: { netAmount: true } }),
      prismaUnscoped.riskAssessment.groupBy({
        by: ['decision'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    return {
      windowDays: 30,
      payments: {
        count: payAgg._count._all,
        volume: (payAgg._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      },
      blockedPayments: blocked,
      fraudAlerts: { open: openAlerts, critical: criticalAlerts },
      settlements: {
        count: settleAgg._count._all,
        net: (settleAgg._sum.netAmount ?? new Prisma.Decimal(0)).toFixed(2),
      },
      riskDecisions: Object.fromEntries(riskByDecision.map((r) => [r.decision, r._count._all])),
    };
  },

  /** Cross-tenant fraud-alert queue with the owning organisation resolved. */
  async fraudAlerts(opts: { status?: string; cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.fraudAlert.findMany({
      where: { ...(opts.status ? { status: opts.status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;

    const orgIds = [...new Set(items.map((a) => a.organizationId).filter((x): x is string => Boolean(x)))];
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = (id: string | null) => orgs.find((o) => o.id === id)?.name ?? '—';

    return {
      items: items.map((a) => ({
        id: a.id,
        organization: nameOf(a.organizationId),
        vhicasarId: a.vhicasarId,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        severity: a.severity,
        status: a.status,
        score: a.score,
        reasons: a.reasons,
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  async resolveAlert(id: string, action: 'CONFIRMED' | 'DISMISSED', resolution?: string) {
    const alert = await prismaUnscoped.fraudAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundError('Fraud alert');
    const updated = await prismaUnscoped.fraudAlert.update({
      where: { id },
      data: { status: action, resolution: resolution ?? null, resolvedAt: new Date() },
    });
    if (action === 'CONFIRMED' && alert.vhicasarId) {
      // Mirror the product-side trust penalty for a confirmed fraud.
      const cur = await prismaUnscoped.trustScore.findUnique({
        where: { subjectType_subjectId: { subjectType: 'CUSTOMER', subjectId: alert.vhicasarId } },
        select: { score: true },
      });
      const next = Math.max(0, (cur?.score ?? 50) - 25);
      await prismaUnscoped.trustScore.upsert({
        where: { subjectType_subjectId: { subjectType: 'CUSTOMER', subjectId: alert.vhicasarId } },
        create: { subjectType: 'CUSTOMER', subjectId: alert.vhicasarId, score: next, lastEventAt: new Date() },
        update: { score: next, lastEventAt: new Date() },
      });
    }
    return updated;
  },
};

// ── Extended Super Admin surfaces (System Bible II §3) ────────────────────

/**
 * AI monitoring, compliance/audit, feature flags, billing and support tools.
 * All cross-tenant and read-mostly; exposed only through the key-gated Service
 * API, never to a tenant.
 */
export const platformAdminService = {
  /** AI adoption and consumption across all organisations. */
  async aiMonitoring(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [usage, byOrg, orgsUsingOwnKey, conversations] = await Promise.all([
      prismaUnscoped.usageCounter.aggregate({
        where: { metric: { startsWith: 'ai_' }, periodStart: { gte: since } },
        _sum: { value: true },
        _count: { _all: true },
      }),
      prismaUnscoped.usageCounter.groupBy({
        by: ['organizationId'],
        where: { metric: { startsWith: 'ai_' }, periodStart: { gte: since } },
        _sum: { value: true },
        orderBy: { _sum: { value: 'desc' } },
        take: 10,
      }),
      // Organisations that brought their own AI key don't consume platform quota.
      prismaUnscoped.organization.count({
        where: { deletedAt: null, settings: { path: ['aiProvider'], not: Prisma.DbNull } },
      }),
      prismaUnscoped.conversation.count({ where: { createdAt: { gte: since } } }),
    ]);

    const orgIds = byOrg.map((o) => o.organizationId);
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];

    return {
      windowDays: days,
      totalAiCalls: usage._sum.value ?? 0,
      metricRows: usage._count._all,
      organizationsWithOwnKey: orgsUsingOwnKey,
      conversations,
      topConsumers: byOrg.map((o) => ({
        organizationId: o.organizationId,
        name: orgs.find((x) => x.id === o.organizationId)?.name ?? '—',
        calls: o._sum.value ?? 0,
      })),
    };
  },

  /** Compliance / audit centre: platform-wide immutable activity. */
  async auditTrail(opts: { action?: string; organizationId?: string; cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.auditLog.findMany({
      where: {
        ...(opts.action ? { action: { contains: opts.action, mode: 'insensitive' as const } } : {}),
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;

    const orgIds = [...new Set(items.map((r) => r.organizationId).filter((x): x is string => Boolean(x)))];
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : [];

    return {
      items: items.map((r) => ({
        id: r.id,
        action: r.action,
        actorType: r.actorType,
        actorUserId: r.actorUserId,
        organization: orgs.find((o) => o.id === r.organizationId)?.name ?? null,
        entityType: r.entityType,
        entityId: r.entityId,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * Compliance summary: the financial and security posture a regulator or
   * auditor would ask about first.
   */
  async complianceSummary() {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [kycPending, kycApproved, unresolvedAlerts, chargebacks, failedPayouts, adminActions] =
      await Promise.all([
        prismaUnscoped.kycSubmission.count({ where: { status: 'PENDING' } }),
        prismaUnscoped.kycSubmission.count({ where: { status: 'APPROVED' } }),
        prismaUnscoped.fraudAlert.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
        prismaUnscoped.chargeback.count({ where: { createdAt: { gte: since } } }),
        prismaUnscoped.payout.count({ where: { status: 'FAILED', requestedAt: { gte: since } } }),
        prismaUnscoped.auditLog.count({ where: { createdAt: { gte: since } } }),
      ]);

    return {
      kyc: { pending: kycPending, approved: kycApproved },
      fraud: { unresolvedAlerts },
      chargebacksLast30Days: chargebacks,
      failedPayoutsLast30Days: failedPayouts,
      auditEventsLast30Days: adminActions,
    };
  },

  /** Billing health across the platform. */
  async billingMonitoring() {
    const [byStatus, planCounts, overdue] = await Promise.all([
      prismaUnscoped.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      prismaUnscoped.subscription.groupBy({
        by: ['planId'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
      prismaUnscoped.subscription.count({ where: { status: 'PAST_DUE' } }),
    ]);
    const planIds = planCounts.map((p) => p.planId);
    const plans = planIds.length
      ? await prismaUnscoped.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, name: true } })
      : [];

    return {
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      pastDue: overdue,
      activeByPlan: planCounts.map((p) => ({
        plan: plans.find((x) => x.id === p.planId)?.name ?? p.planId,
        count: p._count._all,
      })),
    };
  },

  // ---- Feature flags ----

  async listFeatureFlags() {
    const flags = await prismaUnscoped.featureFlag.findMany({
      orderBy: { key: 'asc' },
      include: { _count: { select: { overrides: true } } },
    });
    return flags.map((f) => ({
      id: f.id,
      key: f.key,
      description: f.description,
      isEnabled: f.isEnabled,
      overrides: f._count.overrides,
      updatedAt: f.updatedAt,
    }));
  },

  async upsertFeatureFlag(dto: { key: string; description?: string; isEnabled: boolean }) {
    return prismaUnscoped.featureFlag.upsert({
      where: { key: dto.key },
      create: { key: dto.key, description: dto.description ?? null, isEnabled: dto.isEnabled },
      update: { isEnabled: dto.isEnabled, ...(dto.description ? { description: dto.description } : {}) },
    });
  },

  async setFeatureFlagOverride(key: string, organizationId: string, isEnabled: boolean) {
    const flag = await prismaUnscoped.featureFlag.findUnique({ where: { key } });
    if (!flag) throw new NotFoundError('Feature flag');
    return prismaUnscoped.featureFlagOverride.upsert({
      where: { flagId_organizationId: { flagId: flag.id, organizationId } },
      create: { flagId: flag.id, organizationId, isEnabled },
      update: { isEnabled },
    });
  },

  // ---- Support tools ----

  /**
   * Look up a consumer across the platform for support. Deliberately narrow:
   * identity, wallet balances and recent activity — never another business's
   * private records.
   */
  async lookupIdentity(query: string) {
    const identity = await prismaUnscoped.vhicasarId.findFirst({
      where: {
        OR: [
          { publicId: query.toUpperCase() },
          { phone: query.startsWith('+') ? query : `+${query}` },
          { email: query.toLowerCase() },
        ],
      },
    });
    if (!identity) throw new NotFoundError('Vhicasar ID');

    const [wallets, devices, links, rewards, recentPayments] = await Promise.all([
      prismaUnscoped.wallet.findMany({
        where: { vhicasarId: identity.id },
        select: { currency: true, balance: true, status: true },
      }),
      prismaUnscoped.device.count({ where: { vhicasarId: identity.id, revokedAt: null } }),
      prismaUnscoped.customerLink.count({ where: { vhicasarId: identity.id, status: 'ACTIVE' } }),
      prismaUnscoped.rewardAccount.findUnique({ where: { vhicasarId: identity.id } }),
      prismaUnscoped.paymentSession.count({
        where: { customerVhicasarId: identity.id, status: 'COMPLETED' },
      }),
    ]);

    return {
      identity: {
        id: identity.id,
        publicId: identity.publicId,
        phone: identity.phone,
        email: identity.email,
        displayName: identity.displayName,
        status: identity.status,
        kycLevel: identity.kycLevel,
        createdAt: identity.createdAt,
        lastLoginAt: identity.lastLoginAt,
      },
      wallets: wallets.map((w) => ({ currency: w.currency, balance: w.balance.toFixed(2), status: w.status })),
      devices,
      linkedBusinesses: links,
      rewards: rewards ? { balance: rewards.balance, tier: rewards.tier } : null,
      completedPayments: recentPayments,
    };
  },

  /** Suspend or restore a consumer identity (fraud response / support). */
  async setIdentityStatus(vhicasarId: string, status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED', reason?: string) {
    const identity = await prismaUnscoped.vhicasarId.update({
      where: { id: vhicasarId },
      data: { status },
    });
    // Suspending must also end live sessions, or the ban has no immediate effect.
    if (status !== 'ACTIVE') {
      await prismaUnscoped.appRefreshToken.updateMany({
        where: { vhicasarId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await emitEvent({
      name: 'IdentityStatusChanged',
      aggregateType: 'VhicasarId',
      aggregateId: vhicasarId,
      payload: { status, reason: reason ?? null },
      organizationId: null,
    });
    return { id: identity.id, status: identity.status };
  },

  /** Outbox health — a growing backlog means events aren't reaching subscribers. */
  /**
   * Vhicasar Pay adoption and usage across the platform.
   *
   * Answers the questions a Super Admin actually asks: is Pay being used, by
   * whom, for how much, and is that growing? Volume is reported alongside
   * *counts* because one large transfer and a thousand small payments are very
   * different kinds of healthy.
   */
  async payUsage(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const previousSince = new Date(Date.now() - days * 2 * 86_400_000);

    const [
      sessionsByStatus,
      paymentsByCurrency,
      previousPayments,
      txnsByType,
      consumerWallets,
      activeConsumers,
      newIdentities,
      topOrgs,
      dailyVolume,
      linkStats,
    ] = await Promise.all([
      prismaUnscoped.paymentSession.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prismaUnscoped.payment.groupBy({
        by: ['currency'],
        where: { provider: 'vhicasar_pay', status: 'PAID', createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prismaUnscoped.payment.aggregate({
        where: {
          provider: 'vhicasar_pay',
          status: 'PAID',
          createdAt: { gte: previousSince, lt: since },
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prismaUnscoped.walletTransaction.groupBy({
        by: ['type'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prismaUnscoped.wallet.aggregate({
        where: { ownerType: 'VHICASAR_ID' },
        _count: { _all: true },
        _sum: { balance: true, lockedBalance: true, rewardBalance: true, cashbackBalance: true },
      }),
      // A consumer who moved money in the window, not merely one who exists.
      prismaUnscoped.walletTransaction.findMany({
        where: { createdAt: { gte: since }, initiatorVhicasarId: { not: null } },
        select: { initiatorVhicasarId: true },
        distinct: ['initiatorVhicasarId'],
      }),
      prismaUnscoped.vhicasarId.count({ where: { createdAt: { gte: since } } }),
      prismaUnscoped.payment.groupBy({
        by: ['organizationId'],
        where: { provider: 'vhicasar_pay', status: 'PAID', createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      prismaUnscoped.$queryRaw<{ day: Date; count: bigint; total: Prisma.Decimal }[]>`
        SELECT date_trunc('day', "createdAt") AS day,
               COUNT(*)::bigint AS count,
               COALESCE(SUM("amount"), 0) AS total
        FROM "Payment"
        WHERE "provider" = 'vhicasar_pay' AND "status" = 'PAID' AND "createdAt" >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      prismaUnscoped.paymentLink.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const totalCount = paymentsByCurrency.reduce((n, c) => n + c._count._all, 0);
    const previousCount = previousPayments._count._all;
    const growth = previousCount === 0 ? null : Math.round(((totalCount - previousCount) / previousCount) * 1000) / 10;

    const orgIds = topOrgs.map((o) => o.organizationId).filter((id): id is string => Boolean(id));
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];

    const zero = new Prisma.Decimal(0);
    return {
      windowDays: days,
      payments: {
        count: totalCount,
        previousCount,
        /** Percent change against the preceding window; null when there is no baseline. */
        growthPercent: growth,
        byCurrency: paymentsByCurrency.map((c) => ({
          currency: c.currency,
          count: c._count._all,
          volume: (c._sum.amount ?? zero).toFixed(2),
        })),
      },
      sessions: sessionsByStatus.map((s) => ({
        status: s.status,
        count: s._count._all,
        value: (s._sum.amount ?? zero).toFixed(2),
      })),
      walletActivity: txnsByType.map((t) => ({
        type: t.type,
        count: t._count._all,
        volume: (t._sum.amount ?? zero).toFixed(2),
      })),
      consumerWallets: {
        count: consumerWallets._count._all,
        available: (consumerWallets._sum.balance ?? zero).toFixed(2),
        locked: (consumerWallets._sum.lockedBalance ?? zero).toFixed(2),
        reward: (consumerWallets._sum.rewardBalance ?? zero).toFixed(2),
        cashback: (consumerWallets._sum.cashbackBalance ?? zero).toFixed(2),
      },
      consumers: {
        activeInWindow: activeConsumers.length,
        newInWindow: newIdentities,
        total: await prismaUnscoped.vhicasarId.count({ where: { deletedAt: null } }),
      },
      paymentLinks: Object.fromEntries(linkStats.map((l) => [l.status, l._count._all])),
      topOrganizations: topOrgs
        .map((o) => ({
          organizationId: o.organizationId,
          name: orgs.find((x) => x.id === o.organizationId)?.name ?? 'Unknown',
          count: o._count._all,
          volume: (o._sum.amount ?? zero).toFixed(2),
        }))
        .sort((a, b) => Number(b.volume) - Number(a.volume))
        .slice(0, 10),
      daily: dailyVolume.map((d) => ({
        day: d.day,
        count: Number(d.count),
        volume: d.total.toFixed(2),
      })),
    };
  },

  /**
   * Platform-wide settlement oversight (§13).
   *
   * Everything a Super Admin needs to answer "is money moving, and is any of it
   * stuck?" — queues, failures, delays, verification backlog, account changes
   * and how much the platform is currently holding on merchants' behalf.
   */
  async settlementOversight(opts: { limit?: number } = {}) {
    const limit = opts.limit ?? 25;
    const now = new Date();

    const [byStatus, failed, overdue, awaitingVerification, recentChanges, liquidity, held] =
      await Promise.all([
        prismaUnscoped.settlement.groupBy({
          by: ['status'],
          _count: { _all: true },
          _sum: { netAmount: true },
        }),
        prismaUnscoped.settlement.findMany({
          where: { status: 'FAILED' },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true, organizationId: true, netAmount: true, currency: true,
            failureReason: true, attempts: true, riskScore: true, createdAt: true,
          },
        }),
        // Due but not executed — the signal that the runner has stalled.
        prismaUnscoped.settlement.findMany({
          where: { status: 'PENDING', scheduledFor: { lt: new Date(now.getTime() - 3_600_000) } },
          orderBy: { scheduledFor: 'asc' },
          take: limit,
          select: {
            id: true, organizationId: true, netAmount: true, currency: true, scheduledFor: true,
          },
        }),
        prismaUnscoped.settlementAccount.findMany({
          where: { status: { in: ['PENDING_VERIFICATION', 'REJECTED'] }, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true, organizationId: true, status: true, bankName: true, accountLast4: true,
            rejectionReason: true, createdAt: true,
          },
        }),
        prismaUnscoped.settlementAccountChange.findMany({
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true, organizationId: true, settlementAccountId: true, action: true,
            actorUserId: true, createdAt: true,
          },
        }),
        // What the platform owes merchants right now, per currency.
        prismaUnscoped.wallet.groupBy({
          by: ['currency'],
          where: { purpose: 'SETTLEMENT_PAYABLE' },
          _sum: { balance: true },
        }),
        prismaUnscoped.settlement.findMany({
          where: { status: { in: ['ON_HOLD', 'AWAITING_APPROVAL'] } },
          orderBy: { riskScore: 'desc' },
          take: limit,
          select: {
            id: true, organizationId: true, netAmount: true, currency: true, status: true,
            riskScore: true, failureReason: true, createdAt: true,
          },
        }),
      ]);

    // Resolve names once so the UI never has to fan out per row.
    const orgIds = [
      ...new Set([
        ...failed.map((f) => f.organizationId),
        ...overdue.map((o) => o.organizationId),
        ...awaitingVerification.map((a) => a.organizationId),
        ...recentChanges.map((c) => c.organizationId),
        ...held.map((h) => h.organizationId),
      ]),
    ];
    const orgs = orgIds.length
      ? await prismaUnscoped.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameFor = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

    return {
      queues: byStatus.map((s) => ({
        status: s.status,
        count: s._count._all,
        total: (s._sum.netAmount ?? new Prisma.Decimal(0)).toFixed(2),
      })),
      failed: failed.map((f) => ({ ...f, organizationName: nameFor(f.organizationId), netAmount: f.netAmount.toFixed(2) })),
      overdue: overdue.map((o) => ({
        ...o,
        organizationName: nameFor(o.organizationId),
        netAmount: o.netAmount.toFixed(2),
        overdueByMinutes: o.scheduledFor
          ? Math.floor((now.getTime() - o.scheduledFor.getTime()) / 60_000)
          : null,
      })),
      manualReview: held.map((h) => ({ ...h, organizationName: nameFor(h.organizationId), netAmount: h.netAmount.toFixed(2) })),
      bankVerification: awaitingVerification.map((a) => ({ ...a, organizationName: nameFor(a.organizationId) })),
      accountChanges: recentChanges.map((c) => ({ ...c, organizationName: nameFor(c.organizationId) })),
      /** Platform liquidity: what is owed to merchants, per currency. */
      liquidity: liquidity.map((l) => ({
        currency: l.currency,
        payable: (l._sum.balance ?? new Prisma.Decimal(0)).toFixed(2),
      })),
    };
  },

  async eventHealth() {
    const [pending, failed, published] = await Promise.all([
      prismaUnscoped.domainEvent.count({ where: { status: 'PENDING' } }),
      prismaUnscoped.domainEvent.count({ where: { status: 'FAILED' } }),
      prismaUnscoped.domainEvent.count({ where: { status: 'PUBLISHED' } }),
    ]);
    const oldestPending = await prismaUnscoped.domainEvent.findFirst({
      where: { status: 'PENDING' },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true, name: true },
    });
    return { pending, failed, published, oldestPending };
  },
};
