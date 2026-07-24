import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

/**
 * Role → permission-key resolution, shared by the HTTP guard and by services
 * that need finer control than a route guard can express (e.g. hiding salary
 * from a directory listing the caller is otherwise allowed to read).
 */

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { keys: Set<string>; expires: number }>();

export async function permissionsForRole(roleId: string): Promise<Set<string>> {
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
 * Does the caller of the current request hold any of these permissions?
 * ANY-of semantics, matching `requirePermission`. Super admins and trusted
 * system jobs (which run with `bypassTenant`) always pass.
 */
export async function callerHasPermission(...keys: string[]): Promise<boolean> {
  const ctx = requestContext.get();
  if (!ctx) return false;
  if (ctx.isSuperAdmin || ctx.bypassTenant) return true;
  if (!ctx.roleId) return false;
  const granted = await permissionsForRole(ctx.roleId);
  return keys.some((k) => granted.has(k));
}
