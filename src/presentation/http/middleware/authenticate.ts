import type { RequestHandler } from 'express';
import { AppError, UnauthorizedError } from '../../../shared/errors';
import { requestContext } from '../../../shared/context';
import { tokenService } from '../../../application/auth/token.service';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { resolveEntitlements } from '../../../application/billing/entitlements';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        organizationId: string | null;
        membershipId: string | null;
        roleId: string | null;
        isSuperAdmin: boolean;
      };
      subscriptionDraftReason?: string;
    }
  }
}

/**
 * Verifies the Bearer access token, attaches req.auth, and binds the tenant
 * to the request context so the Prisma extension auto-scopes all queries.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new UnauthorizedError());
    return;
  }
  const payload = tokenService.verifyAccessToken(header.slice(7));
  const user = await prismaUnscoped.user.findUnique({
    where: { id: payload.sub },
    select: { emailVerifiedAt: true, deletedAt: true, status: true },
  });
  if (!user?.emailVerifiedAt) {
    next(new UnauthorizedError('Verify your email address before continuing.', 'EMAIL_NOT_VERIFIED'));
    return;
  }
  if (user.deletedAt || user.status === 'DEACTIVATED') {
    next(new UnauthorizedError('Account is not active', 'ACCOUNT_INACTIVE'));
    return;
  }
  if (payload.org) {
    const organization = await prismaUnscoped.organization.findUnique({
      where: { id: payload.org },
      select: { status: true, deletedAt: true },
    });
    if (!organization || organization.deletedAt || organization.status === 'CANCELLED') {
      next(new UnauthorizedError('Organization is no longer active', 'ORGANIZATION_INACTIVE'));
      return;
    }
    if (organization.status === 'SUSPENDED') {
      next(new UnauthorizedError('Organization has been suspended. Contact support.', 'ORGANIZATION_SUSPENDED'));
      return;
    }
  }

  req.auth = {
    userId: payload.sub,
    organizationId: payload.org,
    membershipId: payload.mem,
    roleId: payload.role,
    isSuperAdmin: payload.sa,
  };

  requestContext.assign({
    userId: payload.sub,
    organizationId: payload.org ?? undefined,
    membershipId: payload.mem ?? undefined,
    roleId: payload.role ?? undefined,
    isSuperAdmin: payload.sa,
  });

  next();
  } catch (error) {
    next(error);
  }
};

/** Requires an active organization on the token (most business routes). */
export const requireTenant: RequestHandler = async (req, _res, next) => {
  if (!req.auth?.organizationId) {
    next(new UnauthorizedError('No active organization on this session', 'NO_ORGANIZATION'));
    return;
  }
  try {
    const entitlements = await resolveEntitlements(req.auth.organizationId);
    if (entitlements.accessRestriction && req.auth.membershipId) {
      const membership = await prismaUnscoped.membership.findUnique({ where: { id: req.auth.membershipId }, select: { isOwner: true } });
      if (!membership?.isOwner) {
        next(new AppError(entitlements.accessRestriction.code, 402, entitlements.accessRestriction.message, { graceEndsAt: entitlements.accessRestriction.graceEndsAt }));
        return;
      }
    }
    next();
  } catch (error) { next(error); }
};
