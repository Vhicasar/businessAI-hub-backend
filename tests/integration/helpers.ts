import { randomUUID } from 'crypto';
import { prismaUnscoped } from '../../src/infrastructure/database/prisma';
import { requestContext, type RequestContext } from '../../src/shared/context';

export const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL);

/** Truncates all app tables (keeps the schema + migration history). */
export async function resetDb(): Promise<void> {
  const tables = await prismaUnscoped.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (list.length > 0) {
    await prismaUnscoped.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}

/** Runs a function inside a tenant-bound request context. */
export function asTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  const ctx: RequestContext = { requestId: randomUUID(), organizationId };
  return requestContext.run(ctx, fn);
}

/** Minimal org + owner user fixture (bypasses HTTP/auth for speed). */
export async function createOrgFixture(name: string) {
  const org = await prismaUnscoped.organization.create({
    data: { name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}` },
  });
  const user = await prismaUnscoped.user.create({
    data: {
      email: `${randomUUID().slice(0, 8)}@test.local`,
      passwordHash: 'x',
      firstName: name,
      lastName: 'Owner',
    },
  });
  const role = await prismaUnscoped.role.create({
    data: { organizationId: org.id, name: 'Owner', isSystem: true },
  });
  const membership = await prismaUnscoped.membership.create({
    data: { organizationId: org.id, userId: user.id, roleId: role.id, isOwner: true },
  });
  return { org, user, role, membership };
}

export async function createCommerceFixture(organizationId: string) {
  const customer = await prismaUnscoped.customer.create({
    data: { organizationId, firstName: 'Test', lastName: 'Customer', email: `c-${randomUUID().slice(0, 8)}@test.local` },
  });
  const warehouse = await prismaUnscoped.warehouse.create({
    data: { organizationId, name: 'Main', code: `MAIN-${randomUUID().slice(0, 4)}`, isDefault: true },
  });
  const product = await prismaUnscoped.product.create({
    data: {
      organizationId,
      name: 'Widget',
      slug: `widget-${randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      variants: {
        create: {
          organizationId,
          sku: `SKU-${randomUUID().slice(0, 8)}`,
          price: 50,
          isDefault: true,
        },
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0]!;
  const stock = await prismaUnscoped.stockLevel.create({
    data: { organizationId, warehouseId: warehouse.id, variantId: variant.id, quantity: 10 },
  });
  return { customer, warehouse, product, variant, stock };
}
