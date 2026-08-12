import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { setAiUsageRecorder } from '../../infrastructure/ai';
import { logger } from '../../shared/logger';
import { resolveEntitlements } from '../billing/entitlements';

/**
 * What AI actually costs, per business.
 *
 * The plan quota was already enforced by counting responses, which says nothing
 * about cost: a one-line reply and a long document summary counted the same.
 * This measures tokens, attributes them to the business and the feature that
 * asked, and turns that into a credit balance an operator can see and adjust.
 *
 * A business using its own API key is metered but never charged — the platform
 * bore no cost, and billing them for it would be wrong.
 */

/** Credits per 1,000 tokens. Whole credits, so a balance is countable. */
const CREDITS_PER_1K_TOKENS = 1;

export function creditsForTokens(totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  // Always at least one: a call that cost something must not round to free.
  return Math.max(1, Math.round((totalTokens / 1000) * CREDITS_PER_1K_TOKENS));
}

export interface RecordUsageInput {
  organizationId: string;
  provider: string;
  model: string;
  feature: string;
  promptTokens?: number;
  completionTokens?: number;
  ownKey?: boolean;
  failed?: boolean;
}

export interface AiBalance {
  organizationId: string;
  planName: string;
  /** Monthly allowance from the plan, null when unlimited. */
  monthlyAllowance: number | null;
  /** Operator grants that are still in force. */
  granted: number;
  /** Credits drawn this period. */
  used: number;
  /** What is left, null when unlimited. */
  remaining: number | null;
  /** Tokens this period, which is what the allowance is really tracking. */
  tokens: number;
  calls: number;
  periodStart: Date;
  periodEnd: Date;
}

/** The calendar month, which is how the plan allowance is described. */
function currentPeriod(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export const aiUsageService = {
  /**
   * Record one provider call.
   *
   * Never throws: metering must not be able to break the feature it measures.
   * A lost usage row is a reporting gap; a thrown error is a failed reply to a
   * customer.
   */
  async record(input: RecordUsageInput): Promise<void> {
    try {
      const promptTokens = Math.max(0, Math.round(input.promptTokens ?? 0));
      const completionTokens = Math.max(0, Math.round(input.completionTokens ?? 0));
      const totalTokens = promptTokens + completionTokens;
      await prismaUnscoped.aiUsageEvent.create({
        data: {
          organizationId: input.organizationId,
          provider: input.provider,
          model: input.model,
          feature: input.feature,
          promptTokens,
          completionTokens,
          totalTokens,
          // Own-key usage costs the platform nothing, so it draws no credit.
          credits: input.ownKey || input.failed ? 0 : creditsForTokens(totalTokens),
          ownKey: Boolean(input.ownKey),
          failed: Boolean(input.failed),
        },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'ai usage not recorded');
    }
  },

  /** Credits granted by an operator and still in force. */
  async grantedFor(organizationId: string, now = new Date()): Promise<number> {
    const grants = await prismaUnscoped.aiCreditGrant.findMany({
      where: {
        organizationId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { credits: true },
    });
    return grants.reduce((sum, g) => sum + g.credits, 0);
  },

  /** Where an organisation stands this month. */
  async balance(organizationId: string, now = new Date()): Promise<AiBalance> {
    const { start, end } = currentPeriod(now);
    const [entitlements, granted, agg] = await Promise.all([
      resolveEntitlements(organizationId).catch(() => null),
      this.grantedFor(organizationId, now),
      prismaUnscoped.aiUsageEvent.aggregate({
        where: { organizationId, createdAt: { gte: start, lt: end }, failed: false },
        _sum: { credits: true, totalTokens: true },
        _count: { _all: true },
      }),
    ]);

    const monthlyAllowance = entitlements?.limits.aiCreditsMonthly ?? null;
    const used = agg._sum.credits ?? 0;

    return {
      organizationId,
      planName: entitlements?.planName ?? 'Unknown',
      monthlyAllowance,
      granted,
      used,
      // Unlimited stays unlimited however much has been granted.
      remaining: monthlyAllowance === null ? null : monthlyAllowance + granted - used,
      tokens: agg._sum.totalTokens ?? 0,
      calls: agg._count._all,
      periodStart: start,
      periodEnd: end,
    };
  },

  /** Record an operator's adjustment. */
  async grant(input: {
    organizationId: string;
    credits: number;
    reason: string;
    grantedById?: string | null;
    expiresAt?: Date | null;
  }) {
    return prismaUnscoped.aiCreditGrant.create({
      data: {
        organizationId: input.organizationId,
        credits: Math.round(input.credits),
        reason: input.reason,
        grantedById: input.grantedById ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });
  },

  async grantsFor(organizationId: string, limit = 50) {
    return prismaUnscoped.aiCreditGrant.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * Platform-wide usage for a window, broken down where an operator needs it:
   * which providers are being used, which features are expensive, and which
   * businesses are consuming the most.
   */
  async platformSummary(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [totals, byProvider, byFeature, topOrgs, failures] = await Promise.all([
      prismaUnscoped.aiUsageEvent.aggregate({
        where: { createdAt: { gte: since }, failed: false },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true, credits: true },
        _count: { _all: true },
      }),
      prismaUnscoped.aiUsageEvent.groupBy({
        by: ['provider'],
        where: { createdAt: { gte: since }, failed: false },
        _sum: { totalTokens: true, credits: true },
        _count: { _all: true },
      }),
      prismaUnscoped.aiUsageEvent.groupBy({
        by: ['feature'],
        where: { createdAt: { gte: since }, failed: false },
        _sum: { totalTokens: true, credits: true },
        _count: { _all: true },
      }),
      prismaUnscoped.aiUsageEvent.groupBy({
        by: ['organizationId'],
        where: { createdAt: { gte: since }, failed: false },
        _sum: { totalTokens: true, credits: true },
        _count: { _all: true },
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 20,
      }),
      prismaUnscoped.aiUsageEvent.count({ where: { createdAt: { gte: since }, failed: true } }),
    ]);

    // Names, so the table reads as businesses rather than as ids.
    const orgs = await prismaUnscoped.organization.findMany({
      where: { id: { in: topOrgs.map((o) => o.organizationId) } },
      select: { id: true, name: true, slug: true },
    });
    const nameById = new Map(orgs.map((o) => [o.id, o]));

    return {
      since,
      totals: {
        calls: totals._count._all,
        promptTokens: totals._sum.promptTokens ?? 0,
        completionTokens: totals._sum.completionTokens ?? 0,
        totalTokens: totals._sum.totalTokens ?? 0,
        credits: totals._sum.credits ?? 0,
        failures,
      },
      byProvider: byProvider.map((p) => ({
        provider: p.provider,
        calls: p._count._all,
        tokens: p._sum.totalTokens ?? 0,
        credits: p._sum.credits ?? 0,
      })),
      byFeature: byFeature
        .map((f) => ({
          feature: f.feature,
          calls: f._count._all,
          tokens: f._sum.totalTokens ?? 0,
          credits: f._sum.credits ?? 0,
        }))
        .sort((a, b) => b.tokens - a.tokens),
      topOrganizations: topOrgs.map((o) => ({
        organizationId: o.organizationId,
        name: nameById.get(o.organizationId)?.name ?? 'Unknown',
        slug: nameById.get(o.organizationId)?.slug ?? null,
        calls: o._count._all,
        tokens: o._sum.totalTokens ?? 0,
        credits: o._sum.credits ?? 0,
      })),
    };
  },
};

/**
 * Connect metering to the provider layer.
 *
 * Called once at startup. Infrastructure holds the hook and this supplies the
 * implementation, so `infrastructure/ai` stays free of application imports
 * while every provider call — from any feature, including ones not written yet
 * — is measured.
 *
 * Fire-and-forget: `record` already swallows its own failures, and awaiting the
 * write would put a database round-trip in front of every AI reply.
 */
export function installAiMetering(): void {
  setAiUsageRecorder((usage) => {
    void aiUsageService.record(usage);
  });
}
