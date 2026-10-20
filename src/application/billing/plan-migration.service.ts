import { z } from 'zod';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { diffTerms, isUnfavourable, termsOfVersion, type TermChange } from './plan-versions';

/**
 * Moving existing subscribers from one plan version to another.
 *
 * Nothing here happens by itself. Publishing a new version leaves everybody
 * where they are; a migration is a separate, deliberate act with a preview, a
 * count the administrator has to acknowledge, and a record of who decided it.
 *
 * The work is resumable because it is written down before it starts: the
 * migration row holds the decision, and each subscription's move is a row in
 * the subscription history. A run that dies halfway can be run again and will
 * skip whatever already moved — the query only ever picks up subscriptions
 * still on the old version.
 */

const ACTIVE = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;
/** Subscriptions per pass. Large plans migrate over several passes. */
const BATCH_SIZE = 200;

export const migrationSchema = z.object({
  toVersionId: z.string().cuid(),
  timing: z.enum(['IMMEDIATE', 'NEXT_RENEWAL']).default('NEXT_RENEWAL'),
  pricing: z.enum(['KEEP_UNTIL_RENEWAL', 'APPLY_IMMEDIATELY', 'APPLY_AT_RENEWAL']).default('APPLY_AT_RENEWAL'),
  reason: z.string().trim().max(500).optional(),
  /** Which version's subscribers to move. Defaults to every older version. */
  fromVersionId: z.string().cuid().optional(),
});
export type MigrationDto = z.infer<typeof migrationSchema>;

export interface MigrationPreview {
  plan: { id: string; name: string; slug: string };
  from: { id: string; version: number; priceMonthly: number; currency: string };
  to: { id: string; version: number; priceMonthly: number; currency: string };
  affected: number;
  changes: TermChange[];
  /** True when somebody pays more or loses something. */
  unfavourable: boolean;
  /** What the preview recommends, and why. */
  recommendedTiming: 'IMMEDIATE' | 'NEXT_RENEWAL';
  recommendationReason: string;
  businesses: { organizationId: string; name: string; status: string; renewsAt: string }[];
}

async function loadVersion(versionId: string) {
  const version = await prismaUnscoped.planVersion.findUnique({
    where: { id: versionId }, include: { plan: true },
  });
  if (!version) throw new NotFoundError('Plan version');
  return version;
}

export const planMigrationService = {
  /**
   * What would happen, without doing it.
   *
   * The affected count comes from the same query the migration uses, so the
   * number an administrator confirms is the number that moves.
   */
  async preview(input: { toVersionId: string; fromVersionId?: string }): Promise<MigrationPreview> {
    const to = await loadVersion(input.toVersionId);
    const from = input.fromVersionId
      ? await loadVersion(input.fromVersionId)
      : await prismaUnscoped.planVersion.findFirst({
          where: { planId: to.planId, id: { not: to.id } },
          orderBy: { version: 'desc' },
          include: { plan: true },
        });
    if (!from) throw new ConflictError('There is no earlier version to migrate from');
    if (from.planId !== to.planId) throw new ConflictError('Both versions must belong to the same plan');
    if (from.id === to.id) throw new ConflictError('A version cannot be migrated to itself');

    const where = {
      planVersionId: from.id,
      status: { in: [...ACTIVE] },
    };
    const [affected, rows] = await Promise.all([
      prismaUnscoped.subscription.count({ where }),
      prismaUnscoped.subscription.findMany({
        where, take: 50, orderBy: { createdAt: 'asc' },
        select: { organizationId: true, status: true, currentPeriodEnd: true },
      }),
    ]);
    const organizations = await prismaUnscoped.organization.findMany({
      where: { id: { in: rows.map((r) => r.organizationId) } },
      select: { id: true, name: true },
    });
    const names = new Map(organizations.map((o) => [o.id, o.name]));

    const changes = diffTerms(termsOfVersion(from), termsOfVersion(to));
    const unfavourable = isUnfavourable(changes);
    return {
      plan: { id: to.plan.id, name: to.plan.name, slug: to.plan.slug },
      from: { id: from.id, version: from.version, priceMonthly: Number(from.priceMonthly), currency: from.currency },
      to: { id: to.id, version: to.version, priceMonthly: Number(to.priceMonthly), currency: to.currency },
      affected,
      changes,
      unfavourable,
      /*
       * A move that costs somebody money or takes something away waits for
       * their renewal by default. Charging more mid-period, or withdrawing a
       * feature a business is using today, is not a decision to arrive at by
       * accepting a default.
       */
      recommendedTiming: unfavourable ? 'NEXT_RENEWAL' : 'IMMEDIATE',
      recommendationReason: unfavourable
        ? 'This version costs more or removes something, so the safe default is to wait until each subscription renews.'
        : 'Nothing is withdrawn and nothing costs more, so this can take effect immediately.',
      businesses: rows.map((row) => ({
        organizationId: row.organizationId,
        name: names.get(row.organizationId) ?? 'Unknown business',
        status: row.status,
        renewsAt: row.currentPeriodEnd.toISOString(),
      })),
    };
  },

  /**
   * Record the decision, then carry it out.
   *
   * `expectedCount` is what the administrator was shown and confirmed. If the
   * real number has moved since — somebody subscribed or cancelled while the
   * dialog was open — the migration refuses rather than quietly affecting a
   * different set of businesses than the one that was agreed to.
   */
  async start(dto: MigrationDto & { expectedCount?: number; initiatedByUserId?: string; initiatedByEmail?: string }) {
    const preview = await this.preview({ toVersionId: dto.toVersionId, fromVersionId: dto.fromVersionId });
    if (dto.expectedCount !== undefined && dto.expectedCount !== preview.affected) {
      throw new ConflictError(
        `This would now affect ${preview.affected} businesses, not the ${dto.expectedCount} you confirmed. Review the preview again.`,
      );
    }

    const migration = await prismaUnscoped.planMigration.create({
      data: {
        planId: preview.plan.id,
        fromVersionId: preview.from.id,
        toVersionId: preview.to.id,
        timing: dto.timing,
        pricing: dto.pricing,
        status: 'RUNNING',
        totalCount: preview.affected,
        reason: dto.reason ?? null,
        initiatedByUserId: dto.initiatedByUserId ?? null,
        initiatedByEmail: dto.initiatedByEmail ?? null,
        startedAt: new Date(),
      },
    });
    logger.info(
      { migrationId: migration.id, plan: preview.plan.slug, from: preview.from.version, to: preview.to.version, affected: preview.affected, timing: dto.timing, by: dto.initiatedByEmail },
      'Plan migration started',
    );
    return this.run(migration.id);
  },

  /**
   * Do the work, a batch at a time. Safe to call again.
   *
   * Idempotent by construction: it only selects subscriptions still on the
   * old version, so anything already moved is invisible to it. Re-running a
   * partial migration finishes it; re-running a finished one does nothing.
   */
  async run(migrationId: string) {
    const migration = await prismaUnscoped.planMigration.findUnique({
      where: { id: migrationId },
      include: { fromVersion: true, toVersion: true, plan: true },
    });
    if (!migration) throw new NotFoundError('Migration');
    if (migration.status === 'CANCELLED') throw new ConflictError('This migration was cancelled');
    if (migration.status === 'COMPLETED') return migration;

    const immediate = migration.timing === 'IMMEDIATE';
    let migrated = 0;
    let failed = 0;

    for (;;) {
      const batch = await prismaUnscoped.subscription.findMany({
        where: {
          planVersionId: migration.fromVersionId,
          status: { in: [...ACTIVE] },
          // A subscription already scheduled by this migration is done.
          ...(immediate ? {} : { pendingPlanVersionId: null }),
        },
        take: BATCH_SIZE,
        orderBy: { id: 'asc' },
      });
      if (batch.length === 0) break;

      for (const subscription of batch) {
        try {
          await prismaUnscoped.$transaction(async (tx) => {
            if (immediate) {
              /*
               * Close the old history row and open a new one, so the timeline
               * reads as a sequence rather than a set of overlapping claims.
               */
              await tx.subscriptionHistory.updateMany({
                where: { subscriptionId: subscription.id, endedAt: null },
                data: { endedAt: new Date() },
              });
              await tx.subscription.update({
                where: { id: subscription.id },
                data: {
                  planVersionId: migration.toVersionId,
                  pendingPlanVersionId: null,
                  grandfathered: false,
                },
              });
              await tx.subscriptionHistory.create({
                data: {
                  organizationId: subscription.organizationId,
                  subscriptionId: subscription.id,
                  planId: migration.planId,
                  planVersionId: migration.toVersionId,
                  version: migration.toVersion.version,
                  priceMonthly: migration.pricing === 'KEEP_UNTIL_RENEWAL'
                    ? migration.fromVersion.priceMonthly
                    : migration.toVersion.priceMonthly,
                  currency: migration.toVersion.currency,
                  interval: subscription.interval,
                  changeType: 'MIGRATED',
                  migrationId: migration.id,
                  initiatedBy: migration.initiatedByEmail,
                  reason: migration.reason,
                },
              });
            } else {
              /*
               * Scheduled, not applied. The subscription keeps answering from
               * its current version until renewal — which is the difference
               * between "at next renewal" and "immediately", and the reason
               * entitlements deliberately ignore the pending pointer.
               */
              await tx.subscription.update({
                where: { id: subscription.id },
                data: { pendingPlanVersionId: migration.toVersionId },
              });
            }
          });
          migrated += 1;
        } catch (error) {
          failed += 1;
          logger.error(
            { err: (error as Error).message, migrationId, subscriptionId: subscription.id },
            'Could not migrate subscription',
          );
        }
      }

      await prismaUnscoped.planMigration.update({
        where: { id: migrationId },
        data: { migratedCount: { increment: migrated }, failedCount: { increment: failed } },
      });
      migrated = 0;
      failed = 0;
      if (batch.length < BATCH_SIZE) break;
    }

    const final = await prismaUnscoped.planMigration.findUniqueOrThrow({ where: { id: migrationId } });
    const remaining = await prismaUnscoped.subscription.count({
      where: {
        planVersionId: migration.fromVersionId,
        status: { in: [...ACTIVE] },
        ...(immediate ? {} : { pendingPlanVersionId: null }),
      },
    });
    const status = remaining > 0 || final.failedCount > 0 ? 'PARTIAL' : 'COMPLETED';
    const updated = await prismaUnscoped.planMigration.update({
      where: { id: migrationId },
      data: { status, completedAt: status === 'COMPLETED' ? new Date() : null },
    });
    logger.info({ migrationId, status, migrated: final.migratedCount, failed: final.failedCount, remaining }, 'Plan migration finished a pass');
    return updated;
  },

  /**
   * Stop a migration that has not finished.
   *
   * Only the scheduled half can be undone: a subscription already moved has
   * had its entitlements change and possibly been billed, and quietly moving
   * it back would be a second unannounced change.
   */
  async cancel(migrationId: string) {
    const migration = await prismaUnscoped.planMigration.findUnique({ where: { id: migrationId } });
    if (!migration) throw new NotFoundError('Migration');
    if (migration.status === 'COMPLETED') {
      throw new ConflictError('This migration has already finished and cannot be undone here.');
    }
    const cleared = await prismaUnscoped.subscription.updateMany({
      where: { pendingPlanVersionId: migration.toVersionId },
      data: { pendingPlanVersionId: null },
    });
    const updated = await prismaUnscoped.planMigration.update({
      where: { id: migrationId }, data: { status: 'CANCELLED', completedAt: new Date() },
    });
    logger.info({ migrationId, scheduledCleared: cleared.count }, 'Plan migration cancelled');
    return { ...updated, scheduledCleared: cleared.count };
  },

  /**
   * Apply a scheduled migration at renewal.
   *
   * Called from the renewal path. Returns the version now in force so the
   * caller can bill the right amount.
   */
  async applyPendingAtRenewal(subscriptionId: string) {
    const subscription = await prismaUnscoped.subscription.findUnique({
      where: { id: subscriptionId },
      include: { pendingVersion: true },
    });
    if (!subscription?.pendingPlanVersionId || !subscription.pendingVersion) return null;

    const migration = await prismaUnscoped.planMigration.findFirst({
      where: { toVersionId: subscription.pendingPlanVersionId, status: { in: ['RUNNING', 'PARTIAL', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    await prismaUnscoped.$transaction(async (tx) => {
      await tx.subscriptionHistory.updateMany({
        where: { subscriptionId, endedAt: null }, data: { endedAt: new Date() },
      });
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          planVersionId: subscription.pendingPlanVersionId,
          pendingPlanVersionId: null,
          grandfathered: false,
        },
      });
      await tx.subscriptionHistory.create({
        data: {
          organizationId: subscription.organizationId,
          subscriptionId,
          planId: subscription.planId,
          planVersionId: subscription.pendingPlanVersionId,
          version: subscription.pendingVersion!.version,
          priceMonthly: subscription.pendingVersion!.priceMonthly,
          currency: subscription.pendingVersion!.currency,
          interval: subscription.interval,
          changeType: 'MIGRATED',
          migrationId: migration?.id ?? null,
          initiatedBy: migration?.initiatedByEmail ?? null,
          reason: migration?.reason ?? 'Scheduled migration applied at renewal',
        },
      });
    });
    logger.info({ subscriptionId, version: subscription.pendingVersion.version }, 'Scheduled plan migration applied at renewal');
    return subscription.pendingVersion;
  },

  /** Everything that ever happened to one business's subscription. */
  async historyFor(organizationId: string) {
    const rows = await prismaUnscoped.subscriptionHistory.findMany({
      where: { organizationId },
      orderBy: { startedAt: 'desc' },
      include: { migration: { select: { id: true, timing: true, reason: true, initiatedByEmail: true } } },
    });
    const planIds = [...new Set(rows.map((r) => r.planId))];
    const plans = await prismaUnscoped.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, name: true } });
    const names = new Map(plans.map((p) => [p.id, p.name]));
    return rows.map((row) => ({
      id: row.id,
      planName: names.get(row.planId) ?? 'Unknown plan',
      version: row.version,
      priceMonthly: row.priceMonthly === null ? null : Number(row.priceMonthly),
      currency: row.currency,
      interval: row.interval,
      changeType: row.changeType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      initiatedBy: row.initiatedBy,
      reason: row.reason,
      migration: row.migration,
    }));
  },

  /** Every migration run against a plan. */
  async migrationsFor(planId: string) {
    return prismaUnscoped.planMigration.findMany({
      where: { planId },
      orderBy: { createdAt: 'desc' },
      include: {
        fromVersion: { select: { version: true, priceMonthly: true } },
        toVersion: { select: { version: true, priceMonthly: true } },
      },
    });
  },
};

