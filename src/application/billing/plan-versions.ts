import { Prisma } from '@prisma/client';
import type { Plan, PlanVersion } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';

/**
 * Cutting and comparing plan versions.
 *
 * A plan row is a moving target — the admin edits it, the sync rewrites it —
 * and until now that rewrote what every existing subscriber was entitled to,
 * retroactively and without anybody choosing it. A version is the fix: an
 * immutable record of what the terms were, which a subscription points at.
 *
 * The rule the rest of this module exists to keep: **a published version is
 * never edited and never deleted.** Changing terms means cutting a new
 * version and deciding, explicitly, what happens to the people on the old one.
 */

/** The fields that define what a subscriber gets. */
export interface VersionTerms {
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  prices: Prisma.InputJsonValue | null;
  maxUsers: number | null;
  maxBranches: number | null;
  maxProducts: number | null;
  maxChannels: number | null;
  maxContacts: number | null;
  maxMarketingReach: number | null;
  aiCreditsMonthly: number | null;
  features: string[];
}

export function termsOfPlan(plan: Plan): VersionTerms {
  return {
    priceMonthly: Number(plan.priceMonthly),
    priceYearly: Number(plan.priceYearly),
    currency: plan.currency,
    prices: (plan.prices ?? null) as Prisma.InputJsonValue | null,
    maxUsers: plan.maxUsers,
    maxBranches: plan.maxBranches,
    maxProducts: plan.maxProducts,
    maxChannels: plan.maxChannels,
    maxContacts: plan.maxContacts,
    maxMarketingReach: plan.maxMarketingReach,
    aiCreditsMonthly: plan.aiCreditsMonthly,
    features: featureList(plan.features),
  };
}

export function termsOfVersion(version: PlanVersion): VersionTerms {
  return {
    priceMonthly: Number(version.priceMonthly),
    priceYearly: Number(version.priceYearly),
    currency: version.currency,
    prices: (version.prices ?? null) as Prisma.InputJsonValue | null,
    maxUsers: version.maxUsers,
    maxBranches: version.maxBranches,
    maxProducts: version.maxProducts,
    maxChannels: version.maxChannels,
    maxContacts: version.maxContacts,
    maxMarketingReach: version.maxMarketingReach,
    aiCreditsMonthly: version.aiCreditsMonthly,
    features: featureList(version.features),
  };
}

function featureList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string').sort() : [];
}

/**
 * Do two sets of terms mean the same thing to a subscriber?
 *
 * Used to decide whether an admin edit is worth a new version. Comparing the
 * meaning rather than the rows keeps a sync that re-sends identical values
 * from cutting a version every few minutes — the history would be unreadable
 * and every plan would be on v4,000 by the weekend.
 */
export function sameTerms(a: VersionTerms, b: VersionTerms): boolean {
  return a.priceMonthly === b.priceMonthly
    && a.priceYearly === b.priceYearly
    && a.currency === b.currency
    && JSON.stringify(a.prices ?? null) === JSON.stringify(b.prices ?? null)
    && a.maxUsers === b.maxUsers
    && a.maxBranches === b.maxBranches
    && a.maxProducts === b.maxProducts
    && a.maxChannels === b.maxChannels
    && a.maxContacts === b.maxContacts
    && a.maxMarketingReach === b.maxMarketingReach
    && a.aiCreditsMonthly === b.aiCreditsMonthly
    && a.features.join('|') === b.features.join('|');
}

export interface TermChange {
  key: string;
  label: string;
  from: string | number | null | boolean;
  to: string | number | null | boolean;
  direction: 'increase' | 'decrease' | 'added' | 'removed' | 'changed';
}

const LIMIT_LABELS: Record<string, string> = {
  maxUsers: 'Users',
  maxBranches: 'Businesses',
  maxProducts: 'Products',
  maxChannels: 'Channels',
  maxContacts: 'Contacts',
  maxMarketingReach: 'Marketing reach',
  aiCreditsMonthly: 'AI credits',
};

/**
 * What changed between two versions, in the words an administrator uses.
 *
 * Drives the comparison table and the migration preview, so the person
 * clicking "move 37 businesses" can see what they are moving them to.
 */
export function diffTerms(from: VersionTerms, to: VersionTerms): TermChange[] {
  const changes: TermChange[] = [];

  if (from.priceMonthly !== to.priceMonthly) {
    changes.push({
      key: 'priceMonthly', label: 'Monthly price',
      from: from.priceMonthly, to: to.priceMonthly,
      direction: to.priceMonthly > from.priceMonthly ? 'increase' : 'decrease',
    });
  }
  if (from.priceYearly !== to.priceYearly) {
    changes.push({
      key: 'priceYearly', label: 'Yearly price',
      from: from.priceYearly, to: to.priceYearly,
      direction: to.priceYearly > from.priceYearly ? 'increase' : 'decrease',
    });
  }
  if (from.currency !== to.currency) {
    changes.push({ key: 'currency', label: 'Currency', from: from.currency, to: to.currency, direction: 'changed' });
  }

  for (const key of Object.keys(LIMIT_LABELS) as (keyof VersionTerms)[]) {
    const before = from[key] as number | null;
    const after = to[key] as number | null;
    if (before === after) continue;
    // Null means unlimited, which is always the larger of the two.
    const direction = before === null ? 'decrease'
      : after === null ? 'increase'
      : after > before ? 'increase' : 'decrease';
    changes.push({ key: String(key), label: LIMIT_LABELS[String(key)]!, from: before, to: after, direction });
  }

  for (const feature of to.features) {
    if (!from.features.includes(feature)) {
      changes.push({ key: `feature:${feature}`, label: feature, from: false, to: true, direction: 'added' });
    }
  }
  for (const feature of from.features) {
    if (!to.features.includes(feature)) {
      changes.push({ key: `feature:${feature}`, label: feature, from: true, to: false, direction: 'removed' });
    }
  }
  return changes;
}

/** True when the move costs a subscriber something — money or capability. */
export function isUnfavourable(changes: TermChange[]): boolean {
  return changes.some((change) =>
    change.direction === 'removed'
    || (change.direction === 'increase' && change.key.startsWith('price'))
    || (change.direction === 'decrease' && !change.key.startsWith('price')));
}

/**
 * Cut a new version of a plan from the given terms.
 *
 * Published immediately by default, because an unpublished version is only
 * useful while an admin is still editing it; the caller decides. Publishing
 * retires the previous current version — which stops it being sold without
 * touching anybody already on it.
 */
export async function createVersion(
  planId: string,
  terms: VersionTerms,
  options: { notes?: string | null; publish?: boolean; createdByUserId?: string | null } = {},
): Promise<PlanVersion> {
  const publish = options.publish !== false;
  return prismaUnscoped.$transaction(async (tx) => {
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId }, select: { id: true, currentVersionId: true } });
    const latest = await tx.planVersion.findFirst({
      where: { planId }, orderBy: { version: 'desc' }, select: { version: true },
    });
    const version = await tx.planVersion.create({
      data: {
        planId,
        version: (latest?.version ?? 0) + 1,
        priceMonthly: terms.priceMonthly,
        priceYearly: terms.priceYearly,
        currency: terms.currency,
        prices: terms.prices ?? Prisma.JsonNull,
        maxUsers: terms.maxUsers,
        maxBranches: terms.maxBranches,
        maxProducts: terms.maxProducts,
        maxChannels: terms.maxChannels,
        maxContacts: terms.maxContacts,
        maxMarketingReach: terms.maxMarketingReach,
        aiCreditsMonthly: terms.aiCreditsMonthly,
        features: terms.features,
        notes: options.notes ?? null,
        createdByUserId: options.createdByUserId ?? null,
        publishedAt: publish ? new Date() : null,
      },
    });

    if (publish) {
      /*
       * Retiring the old version stops it being offered to new customers. It
       * deliberately does not touch the subscriptions pointing at it: that is
       * what "keep existing subscribers" means, and it is the default.
       */
      if (plan.currentVersionId && plan.currentVersionId !== version.id) {
        await tx.planVersion.update({
          where: { id: plan.currentVersionId },
          data: { retiredAt: new Date() },
        });
      }
      await tx.plan.update({ where: { id: planId }, data: { currentVersionId: version.id } });
    }
    return version;
  });
}

/** The version a new subscriber should get. */
export async function currentVersion(planId: string): Promise<PlanVersion | null> {
  const plan = await prismaUnscoped.plan.findUnique({
    where: { id: planId }, select: { currentVersionId: true },
  });
  if (!plan?.currentVersionId) {
    logger.warn({ planId }, 'Plan has no current version — falling back to the plan row');
    return null;
  }
  return prismaUnscoped.planVersion.findUnique({ where: { id: plan.currentVersionId } });
}
