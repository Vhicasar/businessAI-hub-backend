import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../../shared/errors';
import { prisma } from '../../../infrastructure/database/prisma';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { keys: Set<string>; expires: number }>();

async function permissionsForRole(roleId: string): Promise<Set<string>> {
  const hit = cache.get(roleId);
  if (hit && hit.expires > Date.now()) return hit.keys;

  const rows = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permission: { select: { key: true } } },
  });
  const keys = new Set(rows.map((r) => r.permission.key));
  cache.set(roleId, { keys, expires: Date.now() + CACHE_TTL_MS });
  return keys;
}

/** Invalidate after role edits (call from role management use cases). */
export function invalidateRoleCache(roleId?: string): void {
  if (roleId) cache.delete(roleId);
  else cache.clear();
}

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
