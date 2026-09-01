/*
 * The requisitions screen: raising, approving and moving stock from the web.
 *
 * Structural, because the failure that matters is the screen and the API
 * disagreeing — a route that does not exist, or a field the server never sends.
 */
import { readFileSync } from 'node:fs';

const WEB = '/Users/mac/Desktop/Development/businesshub-ai/web/src';
const API = '/Users/mac/Desktop/Development/businesshub-ai/backend/src';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const page = readFileSync(`${WEB}/features/inventory/RequisitionsPage.tsx`, 'utf8');
const router = readFileSync(`${WEB}/app/router.tsx`, 'utf8');
const nav = readFileSync(`${WEB}/layouts/navItems.ts`, 'utf8');
const routes = readFileSync(`${API}/presentation/http/v1/requisitions.routes.ts`, 'utf8');
const svc = readFileSync(`${API}/application/inventory/requisitions.service.ts`, 'utf8');
const inv = readFileSync(`${API}/presentation/http/v1/inventory.routes.ts`, 'utf8');

console.log('\n=== 1. IT IS REACHABLE ===');
check('the page is routed', router.includes("{ path: 'requisitions', element: <RequisitionsPage /> }"));
check('and in the side menu', nav.includes("path: '/requisitions'"));
check('gated on inventory access', page.includes("<RequirePermission keys={['inventory.read']}>"));

console.log('\n=== 2. EVERY CALL HAS AN ENDPOINT ===');
for (const [call, route] of [
  ["api<Requisition[]>('/requisitions')", "requisitionsRoutes.get(\n  '/',"],
  ["api('/requisitions', {", "requisitionsRoutes.post(\n  '/',"],
]) {
  check(`${call.slice(0, 34)}… is served`, page.includes(call) && routes.includes(route));
}
for (const action of ['submit', 'approve', 'reject', 'dispatch', 'receive', 'cancel']) {
  check(`/${action} exists on the server`, routes.includes(`'/:id/${action}'`));
}
check('the page drives them all through one action call',
  /api\(`\/requisitions\/\$\{id\}\/\$\{action\}`/.test(page));
check('warehouses come from the inventory API',
  page.includes("api<Warehouse[]>('/inventory/warehouses')") && inv.includes("'/warehouses'"));
check('and source stock too',
  /\/inventory\/stock\?warehouseId=/.test(page) && inv.includes("'/stock'"));

console.log('\n=== 3. THE STOCK QUERY IS ONE THE SERVER ACCEPTS ===');
{
  /*
   * The bug this guards: the page asked for limit=200 while the server caps it
   * at 100, so every request 400'd and the product dropdown came back empty —
   * indistinguishable from a warehouse with no stock.
   */
  const invSvc = readFileSync(`${API}/application/inventory/inventory.service.ts`, 'utf8');
  const cap = /listStockSchema[\s\S]*?limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/.exec(invSvc);
  check('the server declares a maximum page size', Boolean(cap), 'could not read the cap');
  const max = Number(cap?.[1] ?? 0);
  const asked = [...page.matchAll(/\/inventory\/stock\?[^`]*limit=(\d+)/g)].map((m) => Number(m[1]));
  check('the page asks for at least one page of stock', asked.length > 0);
  check(`no request exceeds the server cap of ${max}`,
    asked.every((n) => n <= max), `asked for ${asked.join(', ')}`);
}

console.log('\n=== 4. A FAILED LOAD IS NOT MISTAKEN FOR NO STOCK ===');
{
  check('a load failure is surfaced', /stockFailed && \(/.test(page));
  check('saying products could not be listed',
    /could not be loaded, so no products can be listed/.test(page));
  check('the field distinguishes loading, failed and genuinely empty',
    /Loading stock…/.test(page) && /Stock could not be loaded/.test(page) &&
    /No stock in the supplying warehouse/.test(page));
}

console.log('\n=== 5. AVAILABILITY IS SHOWN BEFORE ASKING ===');
check('each product option shows what is available', /\(avail \{s\.available\}\)/.test(page));
check('the quantity field repeats it', /avail \$\{availableFor\(line\.variantId\)\}/.test(page));
check('and a shortfall is spelled out', /exceeds available stock by \$\{s\.short\}/.test(page));
check('as a warning rather than a block',
  /A warning, not a block/.test(page));
check('the server really reports available as quantity minus reserved',
  readFileSync(`${API}/application/inventory/inventory.service.ts`, 'utf8')
    .includes('available: Number(r.quantity) - Number(r.reserved)'));

console.log('\n=== 6. THE SAME WAREHOUSE CANNOT BE BOTH ENDS ===');
check('the destination list excludes the source', /active\.filter\(\(w\) => w\.id !== from\)/.test(page));
check('and the server refuses it anyway',
  svc.includes('A warehouse cannot request stock from itself.'));

console.log('\n=== 7. APPROVAL IS A DECISION, NOT A RUBBER STAMP ===');
check('the approver sees what was requested', /requested \{n\(i\.requestedQty\)\}/.test(page));
check('and what the source actually holds', /available here \{available\}/.test(page));
check('they can approve a smaller quantity', page.includes('size="small" label="Approve" type="number"'));
check('over-approving is flagged against the shelf',
  /More than is on the shelf here/.test(page));
check('and it is stated that approving moves nothing',
  /Approving does not move stock/.test(page));

console.log('\n=== 8. REJECTION NEEDS A REASON ===');
check('the reject step asks for one', page.includes('label="Reason" autoFocus'));
check('the button stays disabled without one', /reason\.trim\(\)\.length < 3 \|\| pending/.test(page));
check('and the server enforces it too',
  svc.includes('Give a reason when rejecting a requisition.'));

console.log('\n=== 9. STOCK ACTIONS EXPLAIN THEMSELVES ===');
check('dispatch says stock leaves the source now',
  /This removes the stock from \$\{r\.fromWarehouse\.name\} now/.test(page));
check('and that it is not counted twice',
  /never counted in two places at once/.test(page));
// Receiving moved from a one-click confirm to a dialog that asks for the
// note's code; the explanation moved with it.
check('receive says it already left the source',
  /It already left\{' '\}\s*\{requisition\.fromWarehouse\.name\}/.test(page));
check('and points at the mobile alternative',
  /scanning the note in the mobile app/.test(page));
check('cancelling states nothing is returned',
  /No stock has moved, /.test(page));

console.log('\n=== 10. ACTIONS FOLLOW PERMISSIONS ===');
for (const p of ['requisition_create', 'requisition_approve', 'requisition_dispatch', 'requisition_receive']) {
  check(`the UI checks inventory.${p}`, page.includes(`hasPermission('inventory.${p}')`));
  check(`and the route enforces it`, routes.includes(`inventory.${p}`));
}

console.log('\n=== 11. THE LIST SAYS WHAT IS OUTSTANDING ===');
check('what is still to dispatch is computed', /const outstanding = r\.items\.reduce/.test(page));
check('and what is in transit', /const inTransit = r\.items\.reduce/.test(page));
check('dispatch only appears when something is owed', /outstanding > 0 &&/.test(page));
check('receive only when something is in transit', /inTransit > 0 && canReceive/.test(page));

console.log('\n=== 12. THE REQUISITION NOTE ===');
{
  const doc = readFileSync(`${WEB}/features/inventory/requisitionDocument.ts`, 'utf8');
  check('a printable note exists', doc.includes('export function printRequisition'));
  check('it carries a QR of the requisition code', /qrSvg\(doc\.scanPayload\)/.test(doc));
  check('the QR caption says the note is required to receive',
    /required to book the stock in/.test(doc));
  check('it shows requested, approved, dispatched and received',
    ['Requested', 'Approved', 'Dispatched', 'Received'].every((h) => doc.includes(`>${h}<`)));
  check('with signature lines for both ends',
    doc.includes('Dispatched by / date') && doc.includes('Received by / date'));
  // It is a stock movement, not a bill — saying so on the page stops it being
  // filed as one.
  check('it states it is not a sale or a demand for payment',
    /Not a sale, and not a\s+demand for payment/.test(doc));
  check('the page can print it', page.includes('printRequisition({'));
  check('and the button is disabled without a code', page.includes('disabled={!r.scanPayload}'));
  check('the list endpoint supplies the payload',
    svc.includes('return rows.map(withScanPayload);'));
}

console.log('\n=== 13. RECEIVING REQUIRES THE NOTE ===');
{
  check('the code is mandatory in the schema',
    /scanToken: z\.string\(\)\.trim\(\)\.min\(8\)\.max\(120\),/.test(svc));
  check('a mismatch is refused', /does not match this requisition/.test(svc));
  check('checked in the service, not only the route',
    /reachable without the screen and this is the control/.test(svc.replace(/\n\s*\*\s?/g, ' ')));
  check('a scan route exists for the phone', routes.includes("'/scan/:token/receive'"));
  check('and it passes the scanned code through', /scanToken: token/.test(routes));
  check('the web asks for the code rather than one-clicking',
    page.includes('label="Code from the requisition note"'));
  check('accepting a pasted deep link too', /replace\(\/\^vhicasar:/.test(page));
  check('and the receipt is recorded as note-verified',
    svc.includes('verifiedByNote: true'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
