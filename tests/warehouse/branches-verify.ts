/*
 * Branches: the locations a business trades from.
 *
 * Modelled since the beginning and read all over the product — staff belong to
 * one, warehouses sit in one, settlement and promotions can be scoped to one —
 * but until now impossible to create. Everything that referenced a branch
 * referenced something that could not exist, and `maxBranches`, sold on every
 * plan, capped nothing.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { branchesService } from '../../src/application/branches/branches.service';
import { resolveEntitlements } from '../../src/application/billing/entitlements';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '';
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

async function main() {
  const org = await db.organization.create({
    data: { name: 'Branch Co', slug: `branch-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  userId = (await db.user.create({
    data: { email: `br-${stamp}@t.test`, passwordHash: 'x', firstName: 'Bola', lastName: 'A' },
  })).id;

  console.log('\n=== 1. THE FIRST BRANCH IS THE HEAD OFFICE ===');
  let lagos = await asUser(() =>
    branchesService.create({ name: 'Lagos', code: `lag${stamp}`.slice(0, 20) }),
  );
  check('it is created', Boolean(lagos.id));
  // Nothing else exists to fall back to, so the flag is not optional here.
  check('and is the head office without being asked', lagos.isHeadOffice === true);
  check('the code is stored upper-case', lagos.code === lagos.code.toUpperCase(), lagos.code);

  console.log('\n=== 2. A SECOND BRANCH DOES NOT STEAL THE FLAG ===');
  const abuja = await asUser(() =>
    branchesService.create({ name: 'Abuja', code: `abj${stamp}`.slice(0, 20) }),
  );
  check('the second is not head office', abuja.isHeadOffice === false);
  check('and the first still is',
    (await asUser(() => branchesService.get(lagos.id))).isHeadOffice === true);

  console.log('\n=== 3. THERE IS ALWAYS EXACTLY ONE HEAD OFFICE ===');
  await asUser(() => branchesService.update(abuja.id, { isHeadOffice: true }));
  {
    const all = await asUser(() => branchesService.list({ includeInactive: true }));
    const heads = all.filter((b) => b.isHeadOffice);
    check('promoting one demotes the other', heads.length === 1, `${heads.length} head offices`);
    check('and it is the one promoted', heads[0]!.id === abuja.id);
  }
  // Clearing the flag outright would leave nothing for anything to fall back
  // to, so it is refused — you move it, you do not remove it.
  {
    let refused = false;
    try {
      await asUser(() => branchesService.update(abuja.id, { isHeadOffice: false }));
    } catch { refused = true; }
    check('the last head office cannot simply be demoted', refused);
  }

  console.log('\n=== 4. CODES ARE UNIQUE WITHIN A BUSINESS ===');
  {
    let refused = false;
    try {
      await asUser(() => branchesService.create({ name: 'Copy', code: lagos.code }));
    } catch { refused = true; }
    check('a duplicate code is refused', refused);

    // A different business may use the same code — they are separate books.
    const other = await db.organization.create({
      data: { name: 'Other Co', slug: `other-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
    });
    const theirs = await requestContext.run({ organizationId: other.id, userId } as never, () =>
      branchesService.create({ name: 'Lagos', code: lagos.code }),
    );
    check('but another business may reuse it', theirs.code === lagos.code);
    await db.branch.deleteMany({ where: { organizationId: other.id } });
    await db.auditLog.deleteMany({ where: { organizationId: other.id } });
    await db.organization.delete({ where: { id: other.id } });
  }

  console.log('\n=== 5. CLOSING KEEPS WHAT DEPENDS ON IT ===');
  {
    // Nothing attached → the row goes.
    const spare = await asUser(() =>
      branchesService.create({ name: 'Spare', code: `spr${stamp}`.slice(0, 20) }),
    );
    const closed = await asUser(() => branchesService.archive(spare.id));
    check('an empty branch is removed outright', closed.removed === true);
    check('and stops appearing', (await asUser(() => branchesService.list({ includeInactive: true })))
      .every((b) => b.id !== spare.id));

    // Something attached → archived, so the thing pointing at it still resolves.
    await db.warehouse.create({
      data: { organizationId: orgId, name: 'Lagos WH', code: `LWH-${stamp}`, branchId: lagos.id },
    });
    const archived = await asUser(() => branchesService.archive(lagos.id));
    check('a branch with a warehouse is archived, not deleted', archived.removed === false);
    check('it is no longer active', archived.isActive === false);
    check('and the warehouse still points at a branch that exists',
      (await db.warehouse.findFirst({ where: { branchId: lagos.id } })) !== null);
    check('it is hidden from the default list',
      (await asUser(() => branchesService.list({ includeInactive: false })))
        .every((b) => b.id !== lagos.id));
    check('but can still be found when asked for',
      (await asUser(() => branchesService.list({ includeInactive: true })))
        .some((b) => b.id === lagos.id));

    lagos = await asUser(() => branchesService.reopen(lagos.id));
    check('and reopening brings it back', lagos.isActive === true);
  }

  console.log('\n=== 6. THE HEAD OFFICE CANNOT BE CLOSED ===');
  {
    let refused = false;
    try {
      await asUser(() => branchesService.archive(abuja.id));
    } catch { refused = true; }
    check('closing the head office is refused', refused);
  }

  console.log('\n=== 7. THE PLAN LIMIT IS REAL NOW ===');
  {
    const ent = await asUser(() => resolveEntitlements(orgId));
    const limit = ent.limits.maxBranches;
    check('the plan states a branch allowance', limit !== undefined, String(limit));
    // The guard itself is middleware, so what is asserted here is that the
    // number it reads is a real one and the count it compares against moves.
    const live = await db.branch.count({ where: { organizationId: orgId, deletedAt: null } });
    check('and branches are countable against it', live > 0, `${live} branches`);
    check(
      'the create route carries the guard',
      (await import('node:fs'))
        .readFileSync('src/presentation/http/v1/branches.routes.ts', 'utf8')
        .includes("enforceLimit('branches')"),
    );
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.warehouse.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.branch.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
