import { z } from 'zod';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import {
  createVersion, diffTerms, isUnfavourable, termsOfPlan, termsOfVersion, type VersionTerms,
} from './plan-versions';

/**
 * What the Vhicasar Admin needs to manage plan versions.
 *
 * Reading side only has to be honest; the writing side has one job, which is
 * to make the consequences of a change visible *before* it is made. The admin
 * can see how many businesses sit on each version, what the next version would
 * change, and who it would affect.
 */

export const newVersionSchema = z.object({
  priceMonthly: z.number().min(0),
  priceYearly: z.number().min(0),
  currency: z.string().length(3),
  prices: z.record(z.unknown()).nullable().optional(),
  maxUsers: z.number().int().min(0).nullable(),
  maxBranches: z.number().int().min(0).nullable(),
  maxProducts: z.number().int().min(0).nullable(),
  maxChannels: z.number().int().min(0).nullable(),
  maxContacts: z.number().int().min(0).nullable(),
  maxMarketingReach: z.number().int().min(0).nullable(),
  aiCreditsMonthly: z.number().int().min(0).nullable(),
  features: z.array(z.string().trim().max(80)).max(200),
  notes: z.string().trim().max(1000).optional(),
  /** Leave false to keep it as a draft while the admin is still editing. */
  publish: z.boolean().default(true),
  createdByUserId: z.string().optional(),
});
export type NewVersionDto = z.infer<typeof newVersionSchema>;

const ACTIVE = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

export const planVersionAdmin = {
  /**
   * Every plan, its current version, and who is on what.
   *
   * The grandfathered count is the number that matters: it is how many
   * businesses are on terms that are no longer sold, which is exactly the
   * thing that used to be invisible.
   */
  async overview() {
    const plans = await prismaUnscoped.plan.findMany({
      orderBy: { position: 'asc' },
      include: { versions: { orderBy: { version: 'desc' } } },
    });

    const counts = await prismaUnscoped.subscription.groupBy({
      by: ['planVersionId'],
      where: { status: { in: [...ACTIVE] } },
      _count: { _all: true },
    });
    const byVersion = new Map(counts.map((row) => [row.planVersionId, row._count._all]));

    return plans.map((plan) => {
      const current = plan.versions.find((v) => v.id === plan.currentVersionId) ?? null;
      const onCurrent = current ? byVersion.get(current.id) ?? 0 : 0;
      const grandfathered = plan.versions
        .filter((v) => v.id !== plan.currentVersionId)
        .reduce((sum, v) => sum + (byVersion.get(v.id) ?? 0), 0);
      return {
        id: plan.id,
        name: plan.name,
        slug: plan.slug,
        isPublic: plan.isPublic,
        isActive: plan.isActive,
        currentVersion: current && {
          id: current.id,
          version: current.version,
          priceMonthly: Number(current.priceMonthly),
          priceYearly: Number(current.priceYearly),
          currency: current.currency,
          publishedAt: current.publishedAt,
        },
        activeSubscribers: onCurrent,
        grandfatheredSubscribers: grandfathered,
        versionCount: plan.versions.length,
        versions: plan.versions.map((v) => ({
          id: v.id,
          version: v.version,
          priceMonthly: Number(v.priceMonthly),
          currency: v.currency,
          isCurrent: v.id === plan.currentVersionId,
          publishedAt: v.publishedAt,
          retiredAt: v.retiredAt,
          notes: v.notes,
          subscribers: byVersion.get(v.id) ?? 0,
        })),
      };
    });
  },

  /** One plan's versions, newest first, with subscriber counts. */
  async versions(planId: string) {
    const plan = await prismaUnscoped.plan.findUnique({
      where: { id: planId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!plan) throw new NotFoundError('Plan');
    const counts = await prismaUnscoped.subscription.groupBy({
      by: ['planVersionId'],
      where: { planId, status: { in: [...ACTIVE] } },
      _count: { _all: true },
    });
    const byVersion = new Map(counts.map((row) => [row.planVersionId, row._count._all]));
    return {
      plan: { id: plan.id, name: plan.name, slug: plan.slug, currentVersionId: plan.currentVersionId },
      versions: plan.versions.map((v) => ({
        ...v,
        priceMonthly: Number(v.priceMonthly),
        priceYearly: Number(v.priceYearly),
        isCurrent: v.id === plan.currentVersionId,
        subscribers: byVersion.get(v.id) ?? 0,
      })),
    };
  },

  /**
   * Cut a new version from the admin's edits.
   *
   * Deliberately does nothing to existing subscribers. Moving them is a
   * separate, confirmed action — that separation is the feature.
   */
  async create(planId: string, dto: NewVersionDto) {
    const plan = await prismaUnscoped.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundError('Plan');

    const terms: VersionTerms = {
      priceMonthly: dto.priceMonthly,
      priceYearly: dto.priceYearly,
      currency: dto.currency,
      prices: (dto.prices ?? null) as VersionTerms['prices'],
      maxUsers: dto.maxUsers,
      maxBranches: dto.maxBranches,
      maxProducts: dto.maxProducts,
      maxChannels: dto.maxChannels,
      maxContacts: dto.maxContacts,
      maxMarketingReach: dto.maxMarketingReach,
      aiCreditsMonthly: dto.aiCreditsMonthly,
      features: [...dto.features].sort(),
    };

    const version = await createVersion(planId, terms, {
      notes: dto.notes ?? null,
      publish: dto.publish,
      createdByUserId: dto.createdByUserId ?? null,
    });

    /*
     * The plan row tracks the published version so the pricing page and new
     * checkouts show what is actually being sold. Existing subscriptions are
     * not touched: they point at their own version.
     */
    if (dto.publish) {
      await prismaUnscoped.plan.update({
        where: { id: planId },
        data: {
          priceMonthly: terms.priceMonthly,
          priceYearly: terms.priceYearly,
          currency: terms.currency,
          maxUsers: terms.maxUsers,
          maxBranches: terms.maxBranches,
          maxProducts: terms.maxProducts,
          maxChannels: terms.maxChannels,
          maxContacts: terms.maxContacts,
          maxMarketingReach: terms.maxMarketingReach,
          aiCreditsMonthly: terms.aiCreditsMonthly,
          features: terms.features,
        },
      });
    }

    const kept = await prismaUnscoped.subscription.count({
      where: { planId, planVersionId: { not: version.id }, status: { in: [...ACTIVE] } },
    });
    logger.info(
      { planId, slug: plan.slug, version: version.version, published: dto.publish, subscribersKeptOnOlderVersions: kept },
      'Plan version created',
    );
    return { version: { ...version, priceMonthly: Number(version.priceMonthly), priceYearly: Number(version.priceYearly) }, subscribersKeptOnOlderVersions: kept };
  },

  /** Side-by-side, for the comparison table shown before publishing. */
  async compare(fromId: string, toId: string) {
    const [from, to] = await Promise.all([
      prismaUnscoped.planVersion.findUnique({ where: { id: fromId } }),
      prismaUnscoped.planVersion.findUnique({ where: { id: toId } }),
    ]);
    if (!from || !to) throw new NotFoundError('Plan version');
    const changes = diffTerms(termsOfVersion(from), termsOfVersion(to));
    return {
      from: { id: from.id, version: from.version, terms: termsOfVersion(from) },
      to: { id: to.id, version: to.version, terms: termsOfVersion(to) },
      changes,
      unfavourable: isUnfavourable(changes),
    };
  },

  /** What a plan's next version would look like if nothing were edited. */
  async draftFromPlan(planId: string) {
    const plan = await prismaUnscoped.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundError('Plan');
    return termsOfPlan(plan);
  },
};
