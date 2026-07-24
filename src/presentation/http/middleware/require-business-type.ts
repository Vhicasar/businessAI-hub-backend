import type { RequestHandler } from 'express';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { ForbiddenError } from '../../../shared/errors';

/**
 * Gate a route to organizations of specific business types — e.g. the Real
 * Estate module is only for REAL_ESTATE businesses. Enforced server-side so the
 * API is closed even if the client renders the screen.
 */
export function requireBusinessType(...types: string[]): RequestHandler {
  return (req, _res, next) => {
    const orgId = req.auth?.organizationId;
    if (!orgId) return next(new ForbiddenError('No active business'));
    prismaUnscoped.organization
      .findUnique({ where: { id: orgId }, select: { businessType: true } })
      .then((org) => {
        if (!org || !types.includes(org.businessType)) {
          next(new ForbiddenError('This module is not available for your business type'));
          return;
        }
        next();
      })
      .catch(next);
  };
}
