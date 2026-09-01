/*
 * Every feature is reachable only by a role that may use it.
 *
 * Three layers have to agree, and nothing was checking that they did:
 *
 *   - the server, which is the only one that actually enforces anything;
 *   - the web, whose menu hid three pages that their routes let anyone open;
 *   - the phone, whose modules and actions each name a permission.
 *
 * A gap in the server is a hole. A gap in a client is a button that fails
 * when pressed, which is how someone learns their own access by trial. This
 * holds all three to the same list.
 */
import { readdirSync, readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const V1 = 'src/presentation/http/v1';
const routeFiles = readdirSync(V1).filter((f) => f.endsWith('.ts'));

/**
 * Routes that answer for the caller's own account or session, plus the ones
 * that must work before anyone is signed in. No role governs these: you cannot
 * be denied permission to read your own notifications or log yourself out.
 */
const OWN_IDENTITY_OR_PUBLIC = new Set([
  'auth.routes.ts', 'health.routes.ts', 'notifications.routes.ts',
  // Gated inside the service instead, per entity type — asserted below.
  'search.routes.ts',
]);

interface Route {
  file: string; method: string; path: string;
  permission: boolean; serviceKeyed: boolean;
}

function parseRoutes(): Route[] {
  const out: Route[] = [];
  for (const file of routeFiles) {
    const src = readFileSync(`${V1}/${file}`, 'utf8');
    const routerUse = [...src.matchAll(/\w+Routes\.use\(([^)]*)\)/g)].map((m) => m[1]).join(' ');
    const useHasPermission = /requirePermission/.test(routerUse);
    const serviceKeyed = /requireServiceKey/.test(routerUse);
    // Guards are often named and reused: `const canInvite = requirePermission(…)`.
    const guardNames = [...src.matchAll(/const (\w+)\s*=\s*requirePermission\(/g)].map((m) => m[1]);

    const re = /(\w+Routes)\.(get|post|patch|put|delete)\(\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const tail = src.slice(m.index, m.index + 1200);
      const handlerAt = tail.search(/wrap\(|async \(req|\bc\.\w+/);
      const chain = handlerAt > 0 ? tail.slice(0, handlerAt) : tail.slice(0, 400);
      out.push({
        file, method: m[2]!.toUpperCase(), path: m[3]!,
        permission:
          /requirePermission/.test(chain) ||
          useHasPermission ||
          guardNames.some((n) => new RegExp(`\\b${n}\\b`).test(chain)),
        serviceKeyed,
      });
    }
  }
  return out;
}

const routes = parseRoutes();

console.log('\n=== 1. THE SERVER ENFORCES, EVERYWHERE IT SHOULD ===');
check('routes were found', routes.length > 500, String(routes.length));

const unguarded = routes.filter(
  (r) => !r.permission && !r.serviceKeyed && !OWN_IDENTITY_OR_PUBLIC.has(r.file),
);
/*
 * The remaining exemptions, each one a deliberate decision rather than an
 * oversight. Anything not on this list must carry a permission.
 */
const ALLOWED: Record<string, string> = {
  'settings.routes.ts GET /organization': 'the workspace every member renders from',
  'settings.routes.ts GET /workspace-config': 'the feature flags the UI itself gates on',
  'billing.routes.ts GET /plans': 'the public plan catalogue',
  'users.routes.ts PATCH /me': 'the caller editing their own profile',
  'users.routes.ts POST /accept': 'accepting an invitation, where the token is the credential',
  'settlement.routes.ts GET /banks': 'the gateway’s bank list, not tenant data',
  'qr-center.routes.ts GET /': 'a code has to be readable by whoever prints it',
  'qr-center.routes.ts GET /:id/printable': 'as above',
  'qr-center.routes.ts GET /analytics': 'as above',
  'branding.routes.ts GET /': 'the product’s own branding, needed to render the sign-in page',
  'data-transfer.routes.ts GET /entities': 'the list of exportable types — names, not data',
  'developer.routes.ts GET /scopes': 'the static catalogue of API scopes',
  // Authenticated by the provider's shared secret rather than by a role: an
  // HMAC over the raw body, refused outright when no secret is configured.
  'delivery.routes.ts POST /webhook/:providerId': 'verified by webhook signature',
  'integrations.routes.ts GET /oauth/:provider/callback': 'the OAuth code is the credential',
};
const unexplained = unguarded.filter((r) => !ALLOWED[`${r.file} ${r.method} ${r.path}`]);
check(
  'every route either carries a permission or is a listed exemption',
  unexplained.length === 0,
  unexplained.map((r) => `${r.file} ${r.method} ${r.path}`).join('; '),
);

console.log('\n=== 2. WRITES ARE NEVER THE LOOSE ONES ===');
const looseWrites = unguarded.filter(
  (r) => r.method !== 'GET' && !ALLOWED[`${r.file} ${r.method} ${r.path}`],
);
// The one unguarded write is the delivery webhook, and it is not unguarded —
// it verifies an HMAC over the raw body and refuses when the gateway has no
// secret configured. Asserted rather than assumed.
{
  const src = readFileSync('src/application/delivery/delivery.service.ts', 'utf8');
  check('the delivery webhook verifies its signature', src.includes('verifySignature('));
  check('and refuses when no secret is configured', src.includes('WEBHOOK_NOT_CONFIGURED'));
}
// A read without a permission is an exposure; a write without one is a
// stranger changing the business.
check('no write is left unguarded', looseWrites.length === 0,
  looseWrites.map((r) => `${r.method} ${r.path}`).join('; '));

console.log('\n=== 3. GLOBAL SEARCH GATES EACH TYPE ITSELF ===');
{
  const src = readFileSync('src/application/search/search.service.ts', 'utf8');
  // The route carries no permission on purpose — a mixed result set cannot
  // have one — so the service must gate each searcher instead.
  check('every searcher declares its permissions', !/perms:\s*\[\s*\]/.test(src));
  check('and the gate is actually applied', src.includes('callerHasPermission(...s.perms)'));
}

console.log('\n=== 4. THE WEB HIDES AND BLOCKS THE SAME THINGS ===');
{
  const router = readFileSync('../web/src/app/router.tsx', 'utf8');
  const nav = readFileSync('../web/src/layouts/navItems.ts', 'utf8');

  // Each route object, bounded so a neighbour's guard is not read as its own.
  const marks = [...router.matchAll(/path:\s*'([^']*)'/g)];
  const open: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.index!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : router.length;
    const block = router.slice(start, end);
    const path = marks[i]![1]!;
    const component = /element:\s*\(?\s*<([A-Z]\w+)/.exec(block)?.[1];
    // A redirect renders no feature; its destination is what gets guarded.
    // Both spellings: `Navigate`, and the alias that forwards query strings.
    if (!component || component === 'Navigate' || component === 'RedirectKeepingQuery') continue;
    // A commented-out route is not reachable.
    if (/^\s*\/\//m.test(block.split('\n')[0] ?? '')) continue;
    if (/RequirePermission|RequireFeature/.test(block)) continue;
    open.push(`${path} <${component}>`);
  }

  // Pages that guard themselves instead of at the route.
  const selfGuarded = open.filter((entry) => {
    const component = /<(\w+)>/.exec(entry)?.[1];
    if (!component) return false;
    const hit = findComponent(component);
    return hit !== null && /RequirePermission/.test(hit);
  });
  const reallyOpen = open.filter((e) => !selfGuarded.includes(e));

  const PUBLIC = [
    'login', 'register', '2fa', 'forgot-password', 'reset-password/:token',
    'invite/:token', '/auth', '/auth/verify-email', '/subscribe', '/docs/api',
    '/pay/:token', '/', 'settings', 'profile', '*', 'website', 'designs', 'designs/:id',
  ];
  const gaps = reallyOpen.filter((e) => !PUBLIC.some((p) => e.startsWith(`${p} `)));
  check('no feature route is reachable without a permission', gaps.length === 0, gaps.join('; '));

  // The menu and the routes have to agree, or the padlock lies.
  check('the menu decides access in one place', nav.includes('permissions:'));
  check('and that decision is shared with the routes',
    readFileSync('../web/src/features/auth/access.ts', 'utf8').includes('navItemAccess'));

  // The three that were open: hidden in the menu, but the route let anyone in.
  for (const path of ['warehouses', 'suppliers', 'purchase-orders']) {
    const i = router.indexOf(`path: '${path}'`);
    const block = router.slice(i, i + 400);
    check(`/${path} is guarded`, /RequirePermission/.test(block));
  }
}

function findComponent(name: string): string | null {
  const roots = ['../web/src/features', '../web/src/components', '../web/src/layouts'];
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.tsx')) {
        const src = readFileSync(p, 'utf8');
        if (new RegExp(`function\\s+${name}\\b|const\\s+${name}\\s*[:=]`).test(src)) return src;
      }
    }
  }
  return null;
}

console.log('\n=== 5. THE PHONE NAMES A PERMISSION FOR EVERY MODULE ===');
{
  const catalog = readFileSync('../flutter/lib/features/shell/module_catalog.dart', 'utf8');
  const blocks = catalog.split('BusinessModule(').slice(1);
  const missing: string[] = [];
  for (const raw of blocks) {
    const block = raw.split('\n  ),')[0]!;
    const label = /label: '([^']+)'/.exec(block)?.[1];
    if (!label) continue;
    if (!/permission: '/.test(block)) missing.push(label);
  }
  // Dashboard, Notifications and Settings answer for the caller themselves.
  const expected = ['Dashboard', 'Notifications', 'Settings'];
  check(
    'only the caller’s own screens go without one',
    missing.every((m) => expected.includes(m)),
    missing.filter((m) => !expected.includes(m)).join(', '),
  );
}

console.log('\n=== 6. EVERY PHONE ACTION IS GATED WHERE IT IS OFFERED ===');
{
  const read = (p: string) => readFileSync(`../flutter/lib/features/${p}`, 'utf8');
  const workspace = read('tablet/tablet_module_screen.dart');
  check('creating checks the module’s create permission', workspace.includes('auth.can(form.createPermission)'));
  check('editing checks its update permission', workspace.includes('auth.can(form.updatePermission!)'));
  check('adjusting stock checks inventory.adjust', workspace.includes("can('inventory.adjust')"));
  check('moving a deal checks crm.update', workspace.includes("can('crm.update')"));

  const goodsIn = read('inventory/goods_in_screen.dart');
  check('receiving a delivery checks purchasing.receive', goodsIn.includes("can('purchasing.receive')"));
  check('receiving a transfer checks its own permission', goodsIn.includes("can('inventory.requisition_receive')"));

  const till = read('pos/pos_screen.dart');
  // Operating the till and recording the sale are separate rights, and no
  // seeded role separates them — but a custom one can.
  check('the till checks it may record the sale', till.includes("can('orders.create')"));

  const invoices = read('invoices/invoice_actions.dart');
  for (const p of ['invoices.send', 'payments.record', 'invoices.void']) {
    check(`${p} gates its action`, invoices.includes(`can('${p}')`));
  }

  // A field can need its own permission even inside a form someone may open.
  const forms = read('tablet/module_forms.dart');
  check('salary is offered only to whoever may read pay',
    /permission: 'employees.view_salary'/.test(forms));
  const sheet = read('tablet/module_form_sheet.dart');
  check('and the form honours that', sheet.includes('_auth.can(f.permission!)'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
