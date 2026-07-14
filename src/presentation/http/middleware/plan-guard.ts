import type { RequestHandler } from 'express';
import { AppError, ForbiddenError } from '../../../shared/errors';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { resolveEntitlements, type PlanLimits } from '../../../application/billing/entitlements';
import type { FeatureKey } from '../../../shared/plans';

/**
 * Plan enforcement middleware.
 *
 *  - `requireFeature(key)` — 403 when the org's plan does not include a feature.
 *  - `enforceLimit(kind)`  — 402 when creating one more would exceed the plan's
 *    quota for a countable resource (seats, channels, contacts, …).
 *
 * Both read the org's current entitlements (see billing/entitlements).
 */

/** Blocks the request unless the org's plan includes `feature`. */
export function requireFeature(feature: FeatureKey): RequestHandler {
  return (req, _res, next) => {
    const orgId = req.auth?.organizationId;
    if (!orgId) {
      next(new ForbiddenError());
      return;
    }
    resolveEntitlements(orgId)
      .then((ent) => {
        if (ent.features.has(feature)) {
          next();
        } else {
          next(
            new AppError(
              'FEATURE_NOT_IN_PLAN',
              403,
              `Your ${ent.planName} plan does not include this feature. Upgrade to unlock it.`,
              { feature, plan: ent.planSlug }
            )
          );
        }
      })
      .catch(next);
  };
}

type CountableLimit = 'users' | 'channels' | 'contacts' | 'products' | 'branches';

const LIMIT_FIELD: Record<CountableLimit, keyof PlanLimits> = {
  users: 'maxUsers',
  channels: 'maxChannels',
  contacts: 'maxContacts',
  products: 'maxProducts',
  branches: 'maxBranches',
};

async function currentCount(kind: CountableLimit, orgId: string): Promise<number> {
  switch (kind) {
    case 'users':
      return prismaUnscoped.membership.count({
        where: { organizationId: orgId, isActive: true, deletedAt: null },
      });
    case 'channels':
      return prismaUnscoped.channelAccount.count({ where: { organizationId: orgId } });
    case 'contacts':
      return prismaUnscoped.customer.count({ where: { organizationId: orgId, deletedAt: null } });
    case 'products':
      return prismaUnscoped.product.count({ where: { organizationId: orgId } });
    case 'branches':
      return prismaUnscoped.branch.count({ where: { organizationId: orgId } });
  }
}

const LABEL: Record<CountableLimit, string> = {
  users: 'team members',
  channels: 'connected channels',
  contacts: 'contacts',
  products: 'products',
  branches: 'branches',
};

/**
 * Refuses the request when the org is already at (or above) its plan quota for
 * `kind`. Also counts pending invitations for `users` so seats can't be
 * over-committed. Runs before the create handler.
 */
export function enforceLimit(kind: CountableLimit): RequestHandler {
  return (req, _res, next) => {
    const orgId = req.auth?.organizationId;
    if (!orgId) {
      next(new ForbiddenError());
      return;
    }
    resolveEntitlements(orgId)
      .then(async (ent) => {
        const limit = ent.limits[LIMIT_FIELD[kind]];
        if (limit === null || limit === undefined) {
          next(); // unlimited
          return;
        }
        let used = await currentCount(kind, orgId);
        if (kind === 'users') {
          // Count outstanding invitations so seats can't be over-committed.
          used += await prismaUnscoped.invitation.count({
            where: { organizationId: orgId, acceptedAt: null, expiresAt: { gt: new Date() } },
          });
        }
        if (used >= limit) {
          next(
            new AppError(
              'PLAN_LIMIT_REACHED',
              402,
              `Your ${ent.planName} plan allows up to ${limit} ${LABEL[kind]}. Upgrade your plan to add more.`,
              { kind, limit, used }
            )
          );
          return;
        }
        next();
      })
      .catch(next);
  };
}
