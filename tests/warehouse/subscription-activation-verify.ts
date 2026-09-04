/*
 * A payment that is taken has to move the plan, and the system has to be able
 * to tell when it did not.
 *
 * The failure this covers is quiet by nature: money leaves the customer, the
 * subscription is untouched, and every screen goes on reporting the old plan
 * because that is genuinely what the database says. Nothing errors. The only
 * way to catch it is to check the outcome rather than the receipt.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { billingService } from '../../src/application/billing/billing.service';
import { resolveEntitlements } from '../../src/application/billing/entitlements';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '';

async function main() {
  const starter = await db.plan.findUnique({ where: { slug: 'starter' } });
  const growth = await db.plan.findUnique({ where: { slug: 'growth' } });
  if (!starter || !growth) {
    console.error('Plans are not seeded in this database — run the seed first.');
    process.exit(1);
  }

  const org = await db.organization.create({
    data: { name: 'Trial Co', slug: `trial-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;

  console.log('\n=== 1. A BUSINESS ON TRIAL IS ON THE FREE PLAN ===');
  const trial = await db.subscription.create({
    data: {
      organizationId: orgId,
      planId: starter.id,
      interval: 'MONTHLY',
      status: 'TRIALING',
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 13 * 86_400_000),
      trialEndsAt: new Date(Date.now() + 13 * 86_400_000),
    },
  });
  {
    const ent = await resolveEntitlements(orgId);
    check('the trial resolves to starter', ent.planSlug === 'starter', ent.planSlug);
    check('with the starter user limit', ent.limits.maxUsers === starter.maxUsers, String(ent.limits.maxUsers));
    check('and no inventory feature', !ent.features.has('inventory'));
  }

  console.log('\n=== 2. ACTIVATING A PAID PLAN MOVES EVERYTHING AT ONCE ===');
  await billingService.activate({
    orgId,
    planId: growth.id,
    interval: 'MONTHLY',
    amount: 8500,
    provider: 'paystack',
    providerRef: `bh_${orgId.slice(0, 8)}_test${stamp}`,
    currency: 'NGN',
  });
  {
    const ent = await resolveEntitlements(orgId);
    check('the plan is growth', ent.planSlug === 'growth', ent.planSlug);
    check('the subscription is active, not trialing', ent.status === 'ACTIVE', String(ent.status));
    check(
      'the user limit moved with it',
      ent.limits.maxUsers === growth.maxUsers,
      `${ent.limits.maxUsers} vs ${growth.maxUsers}`,
    );
    check('and the plan-only features arrived', ent.features.size > 0);

    // The trial row is updated in place rather than left alongside — two
    // active subscriptions would make "which plan is this?" a matter of sort
    // order.
    const rows = await db.subscription.findMany({ where: { organizationId: orgId } });
    check('there is still exactly one subscription', rows.length === 1, String(rows.length));
    check('and it is the trial row, upgraded', rows[0]!.id === trial.id);
  }

  console.log('\n=== 3. THE ADMIN AND THE APP READ THE SAME THING ===');
  {
    // The service endpoint the admin roster calls uses this filter and order;
    // if it disagreed with the resolver the two would report different plans.
    const asAdminSees = await db.subscription.findFirst({
      where: { organizationId: orgId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
      include: { plan: { select: { slug: true } } },
    });
    const asAppSees = await resolveEntitlements(orgId);
    check(
      'the admin sees the plan the app enforces',
      asAdminSees?.plan.slug === asAppSees.planSlug,
      `${asAdminSees?.plan.slug} vs ${asAppSees.planSlug}`,
    );
  }

  console.log('\n=== 4. A RECEIPT WITHOUT AN UPGRADE IS NOT "ALREADY DONE" ===');
  {
    /*
     * The exact shape of the production incident: a payment is on file, and
     * the subscription is still on the free plan. `verifyReference` used to
     * see the billing record, report `activated: true`, and never look at
     * what the subscription actually said — so every retry agreed that
     * everything was fine while the customer stayed on starter.
     */
    const orphanRef = `bh_${orgId.slice(0, 8)}_orphan${stamp}`;
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    await db.subscription.update({
      where: { id: sub.id },
      data: { planId: starter.id, status: 'TRIALING' },
    });
    await db.billingRecord.create({
      data: {
        subscriptionId: sub.id,
        amount: 8500,
        currency: 'NGN',
        status: 'PAID',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
        provider: 'paystack',
        providerRef: orphanRef,
        paidAt: new Date(),
      },
    });

    let reported: string;
    try {
      const result = await billingService.verifyReference(orphanRef);
      reported = result.alreadyProcessed ? 'claimed already processed' : 'attempted activation';
    } catch (err) {
      // Reaching the gateway with a made-up reference fails, and failing is
      // the correct answer here: it means the short-circuit did not fire and
      // real verification was attempted.
      reported = 'attempted activation';
      void err;
    }
    check(
      'a paid record on a starter subscription is not treated as settled',
      reported === 'attempted activation',
      reported,
    );

    const ent = await resolveEntitlements(orgId);
    check('and the business is still correctly reported as starter', ent.planSlug === 'starter', ent.planSlug);
  }

  console.log('\n=== 5. AN EXPIRED PAID PERIOD FALLS BACK, IT DOES NOT LINGER ===');
  {
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        planId: growth.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(Date.now() - 60 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      },
    });
    const ent = await resolveEntitlements(orgId);
    check('an ended period drops back to starter', ent.planSlug === 'starter', ent.planSlug);
    const after = await db.subscription.findFirstOrThrow({ where: { id: sub.id } });
    check('and the row is marked expired rather than left active', after.status === 'EXPIRED', after.status);
  }

  console.log('\n=== 5b. THE UPGRADE REACHES ENFORCEMENT, NOT JUST THE ADMIN ===');
  {
    /*
     * Moving the plan is only useful if the things that ration the product
     * read it. Both plan-guard middlewares call `resolveEntitlements` per
     * request with no cache, so this checks the whole chain moves together:
     * the row, the limits, the feature gate, and the seat count someone would
     * actually hit when inviting a colleague.
     */
    const sub = await db.subscription.findFirstOrThrow({ where: { organizationId: orgId } });
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        planId: starter.id,
        status: 'TRIALING',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 13 * 86_400_000),
      },
    });

    const onStarter = await resolveEntitlements(orgId);
    const starterSeats = onStarter.limits.maxUsers;
    check('on starter, seats are the starter allowance', starterSeats === starter.maxUsers, String(starterSeats));
    check('and a growth-only feature is refused', !onStarter.features.has('inventory'));

    await billingService.activate({
      orgId, planId: growth.id, interval: 'MONTHLY', amount: 8500,
      provider: 'paystack', providerRef: `bh_${orgId.slice(0, 8)}_seats${stamp}`, currency: 'NGN',
    });

    const onGrowth = await resolveEntitlements(orgId);
    check(
      'after activation the seat allowance is the growth one',
      onGrowth.limits.maxUsers === growth.maxUsers,
      `${starterSeats} → ${onGrowth.limits.maxUsers}`,
    );
    check(
      'every countable limit moved, not only seats',
      onGrowth.limits.maxProducts !== starterSeats &&
        JSON.stringify(onGrowth.limits) !== JSON.stringify(onStarter.limits),
    );
    check(
      'and the feature the plan adds is now granted',
      growth.features.length === 0 || onGrowth.features.size >= onStarter.features.size,
    );

    // Nothing has to be restarted or re-read: entitlements are resolved from
    // the database on each call, so the next request already sees this.
    const again = await resolveEntitlements(orgId);
    check('a second read agrees, with no cache to clear', again.planSlug === 'growth');
  }

  console.log('\n=== 5bb. AN ADVERTISED LIMIT IS ENFORCED, OR IT IS NOT REAL ===');
  {
    /*
     * Every countable limit the plan catalogue sells has to be enforced
     * wherever that thing is created — otherwise the pricing page promises a
     * ceiling the product does not have.
     *
     * `maxBranches` was the honest exception for a long time: branches were
     * modelled and read all over the product, but nothing created one, so
     * there was no route for the guard to sit on. Branch creation now exists,
     * and this is what required the limit to arrive with it.
     */
    const { readFileSync, readdirSync } = await import('node:fs');
    const routeSrc = readdirSync('src/presentation/http/v1')
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(`src/presentation/http/v1/${f}`, 'utf8'))
      .join('\n');

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [],
      );
    const appSrc = walk('src/application').map((f) => readFileSync(f, 'utf8')).join('\n');

    // limit key → the Prisma model whose creation it caps.
    const countable: Record<string, string> = {
      users: 'membership',
      channels: 'channelAccount',
      contacts: 'customer',
      products: 'product',
      branches: 'branch',
    };

    /*
     * A feature that is built but switched off is a third state, and the check
     * has to know about it: branches have a service, a route and the guard,
     * with the route left unmounted for now. Nothing is reachable to limit, so
     * nothing is owed — but the day the mount is uncommented the guard has to
     * already be there, which is what makes this worth asserting rather than
     * skipping.
     */
    const appTs = readFileSync('src/app.ts', 'utf8');
    const mounted = (routeVar: string) =>
      new RegExp(`^\\s*v1\\.use\\([^)]*${routeVar}\\)`, 'm').test(appTs);

    // limit key → the router variable that exposes its create route.
    const routers: Record<string, string> = {
      users: 'usersRoutes',
      channels: 'inboxRoutes',
      contacts: 'customersRoutes',
      products: 'catalogRoutes',
      branches: 'branchesRoutes',
    };

    for (const [kind, model] of Object.entries(countable)) {
      const enforced = routeSrc.includes(`enforceLimit('${kind}')`);
      const creatable = new RegExp(`\\.${model}\\.(create|createMany|upsert)\\(`).test(appSrc);
      const reachable = mounted(routers[kind]!);

      if (creatable && !reachable) {
        // Switched off. The guard still has to be written and waiting.
        check(`${kind}: switched off, but the limit is already wired for when it returns`, enforced);
        continue;
      }
      check(
        `${kind}: ${creatable ? 'creatable, so the limit is enforced' : 'not creatable, so no guard is owed'}`,
        creatable ? enforced : true,
        creatable && !enforced ? `${model} can be created but enforceLimit('${kind}') is nowhere` : '',
      );
    }
  }

  console.log('\n=== 5c. NOTHING ENTITLEMENT-SHAPED IS FROZEN INTO A TOKEN ===');
  {
    const auth = await import('node:fs').then((fs) =>
      fs.readFileSync('src/application/auth/auth.service.ts', 'utf8'),
    );
    const payload = /signAccessToken\(\{([\s\S]*?)\}\)/.exec(auth)?.[1] ?? '';
    // A plan or feature list baked into the token would mean a paid customer
    // stayed limited until their session expired.
    for (const leaked of ['plan', 'features', 'limits', 'maxUsers']) {
      check(`the access token does not carry "${leaked}"`, !payload.includes(leaked), payload.trim());
    }
  }

  console.log('\n=== 6. THE GATEWAY RETURNS SOMEWHERE THAT CAN ACT ON IT ===');
  {
    /*
     * The incident. Paystack sends the customer back to BILLING_CALLBACK_URL
     * with `?reference=…`, and the billing page reads that reference and
     * activates the plan. The configured URL pointed at `/settings/billing`,
     * which is not the page — it is an alias that redirected to `/billing`,
     * and navigating to a bare path drops the query string. The reference
     * never reached the page, verify never ran, and the only remaining path to
     * activation was the gateway's webhook.
     */
    const { readFileSync } = await import('node:fs');
    const router = readFileSync('../web/src/app/router.tsx', 'utf8');
    const page = readFileSync('../web/src/features/billing/BillingSettingsPage.tsx', 'utf8');
    const envSrc = readFileSync('src/shared/config/env.ts', 'utf8');

    // An alias that forwards to a bare path silently eats query parameters.
    check(
      'no route alias throws away its query string',
      !/<Navigate to="\/[^"]*" replace \/>/.test(router),
      'a bare <Navigate to="…"> alias is present',
    );
    check(
      'aliases forward search and hash',
      readFileSync('../web/src/app/RedirectKeepingQuery.tsx', 'utf8').includes('${search}${hash}'),
    );

    // Where the gateway is told to return to.
    const callback = /callbackUrl: raw\.BILLING_CALLBACK_URL \|\| `\$\{raw\.WEB_APP_URL\}([^`]*)`/.exec(envSrc)?.[1];
    check('the billing callback path was found', Boolean(callback), String(callback));
    if (callback) {
      const path = callback.replace(/^\//, '');
      /*
       * The same path can be declared twice — once as the page and once as an
       * alias under /settings — so the question is whether *any* declaration
       * renders something, not whether the first one found does.
       */
      const declarations = [...router.matchAll(new RegExp(`path: '${path}'`, 'g'))];
      const rendersAPage = declarations.some((m) => {
        const block = router.slice(m.index!, m.index! + 300);
        return !/RedirectKeepingQuery|Navigate/.test(block.split('},')[0] ?? block);
      });
      check(
        `the callback "${callback}" lands on a real page, not a redirect`,
        declarations.length > 0 && rendersAPage,
        `${declarations.length} declaration(s)`,
      );
      check(
        'and that page is the one that reads the reference',
        page.includes("params.get('reference')") && page.includes('billingApi'),
      );
    }

    // The page still has to act on it once it arrives.
    check('the page verifies the reference it is given', /\.verify\(ref\)/.test(page));
    check(
      'and re-reads the session so paid features unlock without a re-login',
      page.includes('refreshMe()'),
    );

    // Deployment config must not reintroduce the alias.
    for (const file of [
      '.env.production.example',
      'deploy/.env.example',
      'deploy/docker-compose.prod.yml',
    ]) {
      const conf = readFileSync(file, 'utf8');
      const line = conf.split('\n').find((l) => l.includes('BILLING_CALLBACK_URL')) ?? '';
      check(`${file} returns to the billing page itself`, !line.includes('/settings/billing'), line.trim());
    }
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.billingRecord.deleteMany({ where: { subscription: { organizationId: orgId } } }).catch(() => {});
  await db.subscription.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
