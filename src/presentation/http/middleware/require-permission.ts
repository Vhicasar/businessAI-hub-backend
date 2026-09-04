import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../../shared/errors';
import { isOwnerMembership, permissionsForRole } from '../../../application/roles/role-permissions';

// Re-exported so existing importers keep working; the cache itself now lives in
// the application layer, where services can consult it too.
export { invalidateRoleCache, callerHasPermission } from '../../../application/roles/role-permissions';

/**
 * Gate a route behind one or more permission keys.
 * Multiple keys = ANY-of semantics. Super admins bypass.
 */
export function requirePermission(...keys: string[]): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new UnauthorizedError();
      if (req.auth.isSuperAdmin) {
        next();
        return;
      }
      if (!req.auth.roleId) throw new ForbiddenError('No role assigned in this organization');

      const granted = await permissionsForRole(req.auth.roleId);
      if (keys.some((k) => granted.has(k))) {
        next();
        return;
      }
      // Checked only once the role has already said no, so the common path
      // costs nothing. See isOwnerMembership for why owners bypass.
      if (req.auth.membershipId && (await isOwnerMembership(req.auth.membershipId))) {
        next();
        return;
      }
      throw new ForbiddenError(`Missing permission: ${keys.join(' or ')}`);
    } catch (e) {
      next(e);
    }
  };
}

/** Platform staff only (/v1/admin/*). */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth?.isSuperAdmin) {
    next(new ForbiddenError('Platform administrator access required'));
    return;
  }
  next();
};
