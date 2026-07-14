import type { Plan, Subscription, SubscriptionStatus } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import type { FeatureKey } from '../../shared/plans';

/**
 * Resolves what an organization is entitled to — its current plan limits and
 * feature set — from its active subscription, falling back to the free
 * "starter" plan when there is no paid subscription. This is the single source
 * of truth for feature gating and limit enforcement.
 *
 * Uses the unscoped client with an explicit organizationId so it works both
 * inside authenticated requests and in system paths (Paystack webhooks).
 */

export interface PlanLimits {
  maxUsers: number | null;
  maxBranches: number | null;
  maxProducts: number | null;
  maxChannels: number | null;
  maxContacts: number | null;
  aiCreditsMonthly: number | null;
}

export interface Entitlements {
  organizationId: string;
  planId: string;
  planSlug: string;
  planName: string;
  status: SubscriptionStatus | 'NONE';
  limits: PlanLimits;
  features: Set<string>;
  /** Current usage-metering window (subscription period, or calendar month for free). */
  periodStart: Date;
  periodEnd: Date;
  subscription: Subscription | null;
}

const ACTIVE_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

function limitsOf(plan: Plan): PlanLimits {
  return {
    maxUsers: plan.maxUsers,
    maxBranches: plan.maxBranches,
    maxProducts: plan.maxProducts,
    maxChannels: plan.maxChannels,
    maxContacts: plan.maxContacts,
    aiCreditsMonthly: plan.aiCreditsMonthly,
  };
}

function featureSet(plan: Plan): Set<string> {
  const raw = plan.features;
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  return new Set(arr.filter((f): f is string => typeof f === 'string'));
}

/** Calendar-month window [firstOfMonth, firstOfNextMonth) in UTC. */
function calendarMonthWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function currentOrgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

/** Loads entitlements for an org (defaults to the request's org). */
export async function resolveEntitlements(orgId?: string): Promise<Entitlements> {
  const organizationId = orgId ?? currentOrgId();

  const subscription = await prismaUnscoped.subscription.findFirst({
    where: { organizationId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });

  const plan =
    subscription?.plan ??
    (await prismaUnscoped.plan.findUnique({ where: { slug: 'starter' } }));

  if (!plan) {
    // No plans seeded — fail open with unlimited to avoid blocking the app.
    const { start, end } = calendarMonthWindow();
    return {
      organizationId,
      planId: 'none',
      planSlug: 'none',
      planName: 'None',
      status: 'NONE',
      limits: {
        maxUsers: null,
        maxBranches: null,
        maxProducts: null,
        maxChannels: null,
        maxContacts: null,
        aiCreditsMonthly: null,
      },
      features: new Set(),
      periodStart: start,
      periodEnd: end,
      subscription: null,
    };
  }

  const window = subscription
    ? { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd }
    : calendarMonthWindow();

  return {
    organizationId,
    planId: plan.id,
    planSlug: plan.slug,
    planName: plan.name,
    status: subscription?.status ?? 'NONE',
    limits: limitsOf(plan),
    features: featureSet(plan),
    periodStart: window.start,
    periodEnd: window.end,
    subscription: subscription ?? null,
  };
}

export function hasFeature(ent: Entitlements, feature: FeatureKey): boolean {
  return ent.features.has(feature);
}
