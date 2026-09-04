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

const ownerCache = new Map<string, { isOwner: boolean; expires: number }>();

/**
 * Is this membership the organisation's owner?
 *
 * Owners bypass permission checks. Not a convenience: an owner can edit roles,
 * so any permission is already theirs for the asking — but an owner moved onto
 * a restricted custom role would otherwise lose the very screen that lets them
 * move themselves back, and lock the business out of its own account
 * administration. Plan and business-type gates are unaffected; this is only
 * about role permissions.
 */
export async function isOwnerMembership(membershipId: string): Promise<boolean> {
  const hit = ownerCache.get(membershipId);
  if (hit && hit.expires > Date.now()) return hit.isOwner;

  const membership = await prisma.membership.findFirst({
    where: { id: membershipId },
    select: { isOwner: true },
  });
  const isOwner = membership?.isOwner ?? false;
  ownerCache.set(membershipId, { isOwner, expires: Date.now() + CACHE_TTL_MS });
  return isOwner;
}

/** Invalidate after role edits (call from role management use cases). */
export function invalidateRoleCache(roleId?: string): void {
  if (roleId) cache.delete(roleId);
  else cache.clear();
  // Ownership can move with a role change, so clear it alongside.
  ownerCache.clear();
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
  if (ctx.roleId) {
    const granted = await permissionsForRole(ctx.roleId);
    if (keys.some((k) => granted.has(k))) return true;
  }
  // Same owner bypass the route guard applies, so a service-level check and a
  // route-level one never disagree about the same caller.
  return ctx.membershipId ? isOwnerMembership(ctx.membershipId) : false;
}
