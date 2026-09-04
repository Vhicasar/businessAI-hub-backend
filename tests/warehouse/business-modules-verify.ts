/*
 * Who gets the Manufacturing module, and who does not.
 *
 * The rule has to hold in one place. A menu that works out its own answer will
 * eventually disagree with the API it opens, and the person on the wrong side
 * of that disagreement sees a screen where every request fails.
 *
 * The cases that matter: a business type that makes things, one that plainly
 * does not, an administrator overriding either way, and — most importantly —
 * every business that existed before any of this was written carrying on
 * exactly as it did.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import {
  BUSINESS_MODULES,
  hasModule,
  isDefaultFor,
  moduleStatusFor,
  modulesFor,
  setModuleOverride,
} from '../../src/application/modules/business-modules';
import type { BusinessType } from '@prisma/client';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
const created: string[] = [];

async function orgOfType(type: BusinessType): Promise<string> {
  const org = await db.organization.create({
    data: {
      name: `${type} Co`,
      slug: `${type.toLowerCase()}-${stamp}-${created.length}`,
      currency: 'NGN', status: 'ACTIVE', country: 'NG', businessType: type,
    },
  });
  created.push(org.id);
  return org.id;
}

async function main() {
  console.log('\n=== 1. BUSINESSES THAT MAKE THINGS GET THE MODULE ===');
  // The brief's list, mapped onto this product's own business types.
  const supported: BusinessType[] = [
    'MANUFACTURING', 'FOOD', 'PHARMACY', 'AGRICULTURE', 'CONSTRUCTION',
  ];
  for (const type of supported) {
    const id = await orgOfType(type);
    check(`${type} has manufacturing`, await hasModule(id, 'manufacturing'));
  }

  console.log('\n=== 2. BUSINESSES THAT DO NOT, DO NOT ===');
  const unsupported: BusinessType[] = [
    'RETAIL', 'WHOLESALE', 'SERVICES', 'REAL_ESTATE', 'SCHOOL',
    'ECOMMERCE', 'DISTRIBUTION', 'SUPERMARKET', 'HOSPITAL', 'OTHER',
  ];
  for (const type of unsupported) {
    const id = await orgOfType(type);
    check(`${type} does not`, !(await hasModule(id, 'manufacturing')));
  }

  console.log('\n=== 3. AN ADMINISTRATOR CAN DECIDE EITHER WAY ===');
  {
    const retail = await orgOfType('RETAIL');
    check('a retailer starts without it', !(await hasModule(retail, 'manufacturing')));

    // A shop that also assembles what it sells is a real business, and the
    // answer is a switch rather than asking them to change their type.
    await setModuleOverride(retail, 'manufacturing', true, { reason: 'Assembles its own kits' });
    check('switching it on works', await hasModule(retail, 'manufacturing'));

    const factory = await orgOfType('MANUFACTURING');
    await setModuleOverride(factory, 'manufacturing', false, { reason: 'Not using it yet' });
    check('and switching it off works even where the type says otherwise',
      !(await hasModule(factory, 'manufacturing')));

    // Clearing is not the same as switching off: it restores the default, and
    // the difference shows the day the business changes type.
    await setModuleOverride(factory, 'manufacturing', null);
    check('clearing the override returns it to the business type',
      await hasModule(factory, 'manufacturing'));
  }

  console.log('\n=== 4. AN ADMINISTRATOR CAN SEE WHY ===');
  {
    const retail = await orgOfType('RETAIL');
    const before = (await moduleStatusFor(retail))[0]!;
    check('off, and says it is because of the business type',
      before.enabled === false && before.source === 'business type');

    await setModuleOverride(retail, 'manufacturing', true, { reason: 'Builds furniture to order' });
    const after = (await moduleStatusFor(retail))[0]!;
    // Without this an administrator cannot tell a module that is off because
    // of the type from one somebody switched off on purpose.
    check('on, and says a person decided that', after.enabled && after.source === 'override');
    check('and records their reason', after.reason === 'Builds furniture to order');
    check('while still reporting what the type would have said',
      after.defaultForBusinessType === false);
  }

  console.log('\n=== 5. EXISTING BUSINESSES ARE UNTOUCHED ===');
  {
    /*
     * The whole product ran without this table. Every business that predates
     * it has no row, and must behave exactly as its type implies — the
     * absence of a decision is not a decision.
     */
    const untouched = await orgOfType('RETAIL');
    const rows = await db.organizationModule.count({ where: { organizationId: untouched } });
    check('a business created today has no override row', rows === 0);
    check('and is simply told no', !(await hasModule(untouched, 'manufacturing')));

    const maker = await orgOfType('FOOD');
    check('while a food producer is simply told yes',
      await hasModule(maker, 'manufacturing'));
    check('with no row needed for that either',
      (await db.organizationModule.count({ where: { organizationId: maker } })) === 0);
  }

  console.log('\n=== 6. THE ANSWER IS THE SAME WHICHEVER WAY IT IS ASKED ===');
  {
    const id = await orgOfType('AGRICULTURE');
    const list = await modulesFor(id);
    const single = await hasModule(id, 'manufacturing');
    // `modulesFor` draws the menu and `hasModule` guards the route. They
    // disagreeing is the exact failure this design exists to prevent.
    check('the list and the single check agree',
      list.includes('manufacturing') === single, `${list.join(',')} vs ${single}`);

    const status = await moduleStatusFor(id);
    check('and so does the administrator view',
      status.find((m) => m.id === 'manufacturing')?.enabled === single);
  }

  console.log('\n=== 7. NONSENSE IS REFUSED, NOT CRASHED ON ===');
  {
    const id = await orgOfType('MANUFACTURING');
    check('an unknown module is simply not available',
      !(await hasModule(id, 'time-travel')));
    let threw = false;
    try {
      await setModuleOverride(id, 'time-travel', true);
    } catch { threw = true; }
    check('and cannot be switched on', threw);
    check('a business that does not exist has no modules',
      (await modulesFor('does-not-exist')).length === 0);
  }

  console.log('\n=== 8. THE REGISTRY IS COHERENT ===');
  {
    check('manufacturing is registered', BUSINESS_MODULES.some((m) => m.id === 'manufacturing'));
    check('every module names the types it is for',
      BUSINESS_MODULES.every((m) => m.defaultFor.length > 0));
    check('and the type check agrees with the registry',
      isDefaultFor('manufacturing', 'MANUFACTURING') && !isDefaultFor('manufacturing', 'RETAIL'));
  }

  console.log('\n=== 9. THE ROUTE GUARD REFUSES THE WRONG BUSINESS ===');
  {
    const { requireModule } = await import('../../src/presentation/http/middleware/require-module');
    const guard = requireModule('manufacturing');

    /** Run the middleware and report what it called `next` with. */
    const run = (organizationId: string | undefined) =>
      new Promise<{ allowed: boolean; code?: string; status?: number }>((resolve) => {
        guard(
          { auth: organizationId ? { organizationId } : undefined } as never,
          {} as never,
          ((err?: unknown) => {
            if (!err) return resolve({ allowed: true });
            const e = err as { code?: string; statusCode?: number };
            resolve({ allowed: false, code: e.code, status: e.statusCode });
          }) as never,
        );
      });

    const factory = await orgOfType('MANUFACTURING');
    const shop = await orgOfType('RETAIL');

    const allowed = await run(factory);
    check('a manufacturer is let through', allowed.allowed);

    const refused = await run(shop);
    // §1: hidden in the menu is not enough — the URL is not a suggestion.
    check('a retailer is refused', !refused.allowed);
    check('with a reason a client can act on', refused.code === 'MODULE_NOT_AVAILABLE', String(refused.code));
    check('and a 403 rather than a 500', refused.status === 403, String(refused.status));

    const anonymous = await run(undefined);
    check('and a request with no business is refused too', !anonymous.allowed);

    // An override is honoured by the guard, not only by the menu.
    await setModuleOverride(shop, 'manufacturing', true, { reason: 'Assembles its own kits' });
    const nowAllowed = await run(shop);
    check('an override lets the same business through', nowAllowed.allowed);
  }

  console.log('\n=== 10. NO MANUFACTURING ROUTE CAN SKIP THE GATE ===');
  {
    /*
     * Applied once per router rather than per route, so the thing to check is
     * that every manufacturing router applies it at all. Forgetting it on a
     * new file is how an estate agency ends up able to create a bill of
     * materials by URL.
     */
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = 'src/presentation/http/v1';
    const manufacturingRouters = readdirSync(dir).filter((f) => f.startsWith('manufacturing'));
    check('the manufacturing routers were found', manufacturingRouters.length >= 3,
      manufacturingRouters.join(', '));

    for (const file of manufacturingRouters) {
      const src = readFileSync(`${dir}/${file}`, 'utf8');
      check(
        `${file} gates every route on the module`,
        /\.use\([^)]*requireModule\('manufacturing'\)/.test(src),
      );
      // The module gate answers "does this business have it"; it says nothing
      // about whether this person may act. Both are needed.
      check(
        `${file} still asks for a permission per route`,
        (src.match(/requirePermission\(/g) ?? []).length > 0,
      );
    }
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  for (const id of created) {
    await db.organizationModule.deleteMany({ where: { organizationId: id } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { organizationId: id } }).catch(() => {});
    await db.organization.delete({ where: { id } }).catch(() => {});
  }
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
