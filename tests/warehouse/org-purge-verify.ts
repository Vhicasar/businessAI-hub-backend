/**
 * Emptying a workspace without locking anybody out.
 *
 * Builds a workspace with a bit of everything, empties it, and then checks the
 * two halves of the promise separately: the business records are gone, and the
 * people can still sign in to what is left.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { catalogService } from '../../src/application/catalog/catalog.service';
import * as purge from '../../src/application/organizations/organization-purge.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '', roleId = '';
const NAME = `Purge Verify ${stamp}`;
const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `pg-${stamp}`, organizationId: orgId, userId }, fn);

async function main() {
  const org = await db.organization.create({
    data: { name: NAME, slug: `purge-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `purge-${stamp}@example.invalid`, firstName: 'Pat', lastName: 'Purge', passwordHash: 'argon2-hash' },
  });
  userId = user.id;
  const role = await db.role.create({ data: { organizationId: orgId, name: 'Owner', isSystem: true } });
  roleId = role.id;
  const membership = await db.membership.create({
    data: { organizationId: orgId, userId, roleId, isOwner: true, isActive: true },
  });
  const refresh = await db.refreshToken.create({
    data: { organizationId: orgId, userId, tokenHash: `hash-${stamp}`, familyId: `fam-${stamp}`, expiresAt: new Date(Date.now() + 86_400_000) },
  });

  // Something of each kind to lose.
  await asOrg(() => catalogService.createProduct({
    name: `Doomed Product ${stamp}`, status: 'ACTIVE', taxRate: 0,
    variants: [{ sku: `DP-${stamp}`, price: 100, isDefault: true, initialStock: 5 }],
  } as never, 'NGN'));
  const customer = await db.customer.create({
    data: { organizationId: orgId, firstName: 'Doomed', lastName: 'Customer', email: `dc-${stamp}@example.invalid` },
  });
  await db.lead.create({ data: { organizationId: orgId, firstName: 'Doomed', source: 'WEBSITE', status: 'NEW' } });
  await db.campaign.create({
    data: { organizationId: orgId, name: `Doomed Campaign ${stamp}`, type: 'EMAIL', status: 'DRAFT', content: {}, stats: {} },
  });

  // ── Preflight ───────────────────────────────────────────────────────────
  console.log('\nBefore anything is touched');
  const before = await purge.purgePreflight(orgId);
  check('it counts what would go', before.totalRows > 0, String(before.totalRows));
  check('products are among them', (before.willDelete.Product ?? 0) >= 1);
  check('so are customers', (before.willDelete.Customer ?? 0) >= 1);
  check('and campaigns', (before.willDelete.Campaign ?? 0) >= 1);
  check('it never proposes deleting memberships', before.willDelete.Membership === undefined);
  check('nor roles', before.willDelete.Role === undefined);
  check('nor refresh tokens', before.willDelete.RefreshToken === undefined);
  check('it names who will still sign in', before.members.some((m) => m.email === user.email));

  // ── Refusals ────────────────────────────────────────────────────────────
  console.log('\nIt refuses what it should');
  let wrongName = '';
  await purge.purgeOrganizationData(orgId, { confirmName: 'Not The Name' }).catch((e) => { wrongName = (e as Error).message; });
  check('a mistyped name is refused', /type the workspace name/i.test(wrongName), wrongName);
  const stillThere = await db.product.count({ where: { organizationId: orgId } });
  check('and nothing was deleted by the attempt', stillThere >= 1);

  // ── The purge ───────────────────────────────────────────────────────────
  console.log('\nEmptying it');
  const result = await purge.purgeOrganizationData(orgId, { confirmName: NAME, actor: 'verify-script' });
  check('it reports what it removed', result.totalDeleted > 0, String(result.totalDeleted));
  check('and nothing was left blocked', Object.keys(result.remaining).length === 0, JSON.stringify(result.remaining));

  console.log('\nThe data is gone');
  for (const [label, count] of [
    ['products', await db.product.count({ where: { organizationId: orgId } })],
    ['variants', await db.productVariant.count({ where: { product: { organizationId: orgId } } })],
    ['customers', await db.customer.count({ where: { organizationId: orgId } })],
    ['leads', await db.lead.count({ where: { organizationId: orgId } })],
    ['campaigns', await db.campaign.count({ where: { organizationId: orgId } })],
    ['warehouses', await db.warehouse.count({ where: { organizationId: orgId } })],
  ] as [string, number][]) {
    check(`no ${label} remain`, count === 0, String(count));
  }

  console.log('\nThey can still sign in');
  check('the organisation still exists', (await db.organization.count({ where: { id: orgId } })) === 1);
  check('the user account survives', (await db.user.count({ where: { id: userId } })) === 1);
  const pw = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  check('with their password intact', pw.passwordHash === 'argon2-hash');
  check('the membership survives', (await db.membership.count({ where: { id: membership.id } })) === 1);
  check('so they still belong to the workspace', result.membersStillAbleToSignIn === 1);
  check('their role survives', (await db.role.count({ where: { id: roleId } })) === 1);
  check('and their session was not torn up', (await db.refreshToken.count({ where: { id: refresh.id } })) === 1);

  // ── The sweep is complete ───────────────────────────────────────────────
  console.log('\nNothing was quietly skipped');
  const after = await purge.purgePreflight(orgId);
  check('a second preflight finds nothing left to delete', after.totalRows === 0,
    JSON.stringify(after.willDelete));

  void customer;

  // ── Permanent deletion takes the records with it ────────────────────────
  console.log('\nDeleting an organisation outright');
  const org2 = await db.organization.create({
    data: { name: `Gone ${stamp}`, slug: `gone-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  const user2 = await db.user.create({
    data: { email: `gone-${stamp}@example.invalid`, firstName: 'G', lastName: 'One', passwordHash: 'x' },
  });
  const role2 = await db.role.create({ data: { organizationId: org2.id, name: 'Owner', isSystem: true } });
  /*
   * Rows that reach the organisation only through a parent.
   *
   * These are what the first attempt missed: a sweep for `organizationId`
   * cannot see a RolePermission or an InvoiceItem, and each one holds its
   * parent in place — the role could not be deleted, so neither could the
   * organisation. Twenty-eight tables are in this position.
   */
  const permissions = await db.permission.findMany({ take: 3, select: { id: true } });
  if (permissions.length > 0) {
    await db.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role2.id, permissionId: permission.id })),
    });
  }
  await db.membership.create({ data: { organizationId: org2.id, userId: user2.id, roleId: role2.id, isOwner: true, isActive: true } });
  await requestContext.run({ requestId: `pg2-${stamp}`, organizationId: org2.id, userId: user2.id }, () =>
    catalogService.createProduct({
      name: `Gone Product ${stamp}`, status: 'ACTIVE', taxRate: 0,
      variants: [{ sku: `GP-${stamp}`, price: 10, isDefault: true, initialStock: 2 }],
    } as never, 'NGN'));
  const goneCustomer = await db.customer.create({
    data: { organizationId: org2.id, firstName: 'Gone', lastName: 'Customer', email: `gc-${stamp}@example.invalid` },
  });
  const goneInvoice = await db.invoice.create({
    data: {
      organizationId: org2.id, number: `INV-GONE-${stamp}`, customerId: goneCustomer.id,
      status: 'SENT', subtotal: 10, taxTotal: 0, discountTotal: 0, total: 10,
    },
  });
  await db.invoiceItem.create({
    data: { invoiceId: goneInvoice.id, description: 'A line that reaches the org only through its invoice', quantity: 1, unitPrice: 10, total: 10 },
  });
  await db.organization.update({ where: { id: org2.id }, data: { deletedAt: new Date() } });

  const gone = await purge.deleteOrganizationCompletely(org2.id, { actor: 'verify-script' });
  check('it reports what it removed', gone.totalDeleted > 0, String(gone.totalDeleted));
  check('and nothing was left blocked', Object.keys(gone.remaining).length === 0, JSON.stringify(gone.remaining));
  check('the organisation row is gone', gone.organizationRemoved === true);

  for (const [label, count] of [
    ['organisations', await db.organization.count({ where: { id: org2.id } })],
    ['products', await db.product.count({ where: { organizationId: org2.id } })],
    ['invoices', await db.invoice.count({ where: { organizationId: org2.id } })],
    ['customers', await db.customer.count({ where: { organizationId: org2.id } })],
    ['memberships', await db.membership.count({ where: { organizationId: org2.id } })],
    ['roles', await db.role.count({ where: { organizationId: org2.id } })],
    ['role permissions', await db.rolePermission.count({ where: { roleId: role2.id } })],
    ['invoice lines', await db.invoiceItem.count({ where: { invoiceId: goneInvoice.id } })],
  ] as [string, number][]) {
    check(`no ${label} remain`, count === 0, String(count));
  }
  check('the person themselves is untouched', (await db.user.count({ where: { id: user2.id } })) === 1);
  await db.user.delete({ where: { id: user2.id } }).catch(() => undefined);

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function cleanup() {
  if (!orgId) return;
  for (const run of [
    () => db.refreshToken.deleteMany({ where: { organizationId: orgId } }),
    () => db.membership.deleteMany({ where: { organizationId: orgId } }),
    () => db.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } }),
    () => db.role.deleteMany({ where: { organizationId: orgId } }),
    () => db.organization.deleteMany({ where: { id: orgId } }),
    () => db.user.deleteMany({ where: { id: userId } }),
  ]) await run().catch((e) => console.log(`  (cleanup: ${(e as Error).message.split('\n')[0].slice(0, 80)})`));
}

main()
  .catch((err) => { failed++; console.error('\nFATAL', err); })
  .finally(async () => { await cleanup(); await db.$disconnect(); process.exit(failed === 0 ? 0 : 1); });
