/**
 * BusinessHub AI — database seed.
 * Idempotent: safe to run repeatedly (upserts everywhere).
 *
 * Seeds:
 *  1. Global permission catalog (from /shared)
 *  2. Subscription plans
 *  3. Re-syncs system-role permissions for every existing organization
 *
 * Run: npm run seed   (uses tsx via prisma.config seed hook)
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLE_TEMPLATES } from '../src/shared/permissions';
import { PLAN_CATALOG } from '../src/shared/plans';

const prisma = new PrismaClient();

async function seedPermissions(): Promise<void> {
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { module: p.module, description: p.description },
      create: p,
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permissions`);
}

async function seedPlans(): Promise<void> {
  for (const p of PLAN_CATALOG) {
    await prisma.plan.upsert({
      where: { slug: p.slug },
      update: { ...p },
      create: { ...p },
    });
  }
  console.log(`✓ ${PLAN_CATALOG.length} plans`);
}

/** Ensures every org has all system roles with template permissions. */
async function syncSystemRoles(): Promise<void> {
  const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permByKey = new Map(permissions.map((p) => [p.key, p.id]));
  const orgs = await prisma.organization.findMany({ select: { id: true } });

  for (const org of orgs) {
    for (const [name, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
      const role = await prisma.role.upsert({
        where: { organizationId_name: { organizationId: org.id, name } },
        update: { isSystem: true, description: tpl.description },
        create: {
          organizationId: org.id,
          name,
          description: tpl.description,
          isSystem: true,
        },
      });
      const wanted = tpl.permissions
        .map((k) => permByKey.get(k))
        .filter((id): id is string => Boolean(id));
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.rolePermission.createMany({
        data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
    }
  }
  console.log(`✓ system roles synced for ${orgs.length} organization(s)`);
}

async function main(): Promise<void> {
  await seedPermissions();
  await seedPlans();
  await syncSystemRoles();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
