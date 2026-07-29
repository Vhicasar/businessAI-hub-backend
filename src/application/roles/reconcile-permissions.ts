import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { ALL_PERMISSIONS, SYSTEM_ROLE_TEMPLATES } from '../../shared/permissions';
import { invalidateRoleCache } from './role-permissions';

/**
 * Reconcile the permission catalog and system-role grants on boot.
 *
 * When a release adds a new permission (e.g. `appointments.*`), the Permission
 * table and every existing org's *system* roles (Owner, Admin, …) must gain it —
 * otherwise the new feature is invisible to owners until someone manually
 * re-seeds. This runs the same non-destructive sync the DB seed does for system
 * roles, but independently of the (currently broken) plan seed, and additively:
 * it only *grants missing* permissions, never revokes, and never touches custom
 * roles. Idempotent and cheap after the first run (no missing grants → no-ops).
 */
export async function reconcileSystemRolePermissions(): Promise<void> {
  try {
    // 1. Ensure the Permission catalog is current.
    for (const p of ALL_PERMISSIONS) {
      await prismaUnscoped.permission.upsert({
        where: { key: p.key },
        create: { key: p.key, module: p.module, description: p.description },
        update: { module: p.module, description: p.description },
      });
    }
    const permissions = await prismaUnscoped.permission.findMany({ select: { id: true, key: true } });
    const idByKey = new Map(permissions.map((p) => [p.key, p.id]));

    // 2. Grant any missing template permissions to each system role.
    const systemRoles = await prismaUnscoped.role.findMany({
      where: { isSystem: true },
      select: { id: true, name: true, permissions: { select: { permissionId: true } } },
    });
    let grants = 0;
    for (const role of systemRoles) {
      const tpl = SYSTEM_ROLE_TEMPLATES[role.name];
      if (!tpl) continue;
      const have = new Set(role.permissions.map((p) => p.permissionId));
      const wanted = tpl.permissions.map((k) => idByKey.get(k)).filter((id): id is string => Boolean(id));
      const missing = wanted.filter((id) => !have.has(id));
      if (missing.length === 0) continue;
      await prismaUnscoped.rolePermission.createMany({
        data: missing.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
      invalidateRoleCache(role.id);
      grants += missing.length;
    }
    if (grants > 0) logger.info({ grants, roles: systemRoles.length }, 'Reconciled system-role permissions');
  } catch (err) {
    // Never block startup on this — the app still runs with existing grants.
    logger.warn({ err: (err as Error).message }, 'System-role permission reconciliation failed');
  }
}
