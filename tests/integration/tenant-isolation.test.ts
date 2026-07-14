import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, prismaUnscoped, disconnectDatabase } from '../../src/infrastructure/database/prisma';
import { HAS_TEST_DB, asTenant, createOrgFixture, resetDb } from './helpers';

describe.skipIf(!HAS_TEST_DB)('tenant isolation (Prisma extension)', () => {
  let orgA: string;
  let orgB: string;
  let customerBId: string;

  beforeAll(async () => {
    await resetDb();
    const a = await createOrgFixture('Alpha');
    const b = await createOrgFixture('Beta');
    orgA = a.org.id;
    orgB = b.org.id;

    await prismaUnscoped.customer.create({
      data: { organizationId: orgA, firstName: 'Ada', email: 'ada@a.test' },
    });
    const cb = await prismaUnscoped.customer.create({
      data: { organizationId: orgB, firstName: 'Bola', email: 'bola@b.test' },
    });
    customerBId = cb.id;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('findMany is scoped to the context organization', async () => {
    const seenByA = await asTenant(orgA, () => prisma.customer.findMany());
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.firstName).toBe('Ada');

    const seenByB = await asTenant(orgB, () => prisma.customer.findMany());
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.firstName).toBe('Bola');
  });

  it('findUnique across tenants behaves as not-found', async () => {
    const crossRead = await asTenant(orgA, () =>
      prisma.customer.findUnique({ where: { id: customerBId } })
    );
    expect(crossRead).toBeNull();
  });

  it('creates auto-inject the context organizationId', async () => {
    const created = await asTenant(orgA, () =>
      prisma.customer.create({ data: { firstName: 'Chi', email: 'chi@a.test' } })
    );
    expect(created.organizationId).toBe(orgA);
  });

  it('cross-tenant updates by unique key are refused', async () => {
    await expect(
      asTenant(orgA, () =>
        prisma.customer.update({ where: { id: customerBId }, data: { firstName: 'Hacked' } })
      )
    ).rejects.toThrow(/Cross-tenant/);
    const untouched = await prismaUnscoped.customer.findUnique({ where: { id: customerBId } });
    expect(untouched?.firstName).toBe('Bola');
  });

  it('updateMany cannot reach other tenants', async () => {
    const result = await asTenant(orgA, () =>
      prisma.customer.updateMany({ data: { isBlocked: true } })
    );
    const blockedInB = await prismaUnscoped.customer.count({
      where: { organizationId: orgB, isBlocked: true },
    });
    expect(result.count).toBeGreaterThan(0);
    expect(blockedInB).toBe(0);
  });

  it('without context, no tenant filter is applied (system paths)', async () => {
    const all = await prismaUnscoped.customer.findMany();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});
