/*
 * The batch/expiry and unit-of-measure surfaces, on web and mobile.
 *
 * Static, because the value here is catching the things that compile and pass
 * types but are still wrong: a filter the API rejects, a screen that reads a
 * failed load as "nothing to worry about", a quantity printed without the unit
 * that gives it meaning.
 */
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const read = (p) => readFileSync(p, 'utf8');

const WEB = '../web/src/features/inventory';
const FLUTTER = '../flutter/lib/features/purchasing';

const panel = read(`${WEB}/ExpiringStockPanel.tsx`);
const inventory = read(`${WEB}/InventoryPage.tsx`);
const scan = read(`${FLUTTER}/receive_scan_screen.dart`);
const routes = read('src/presentation/http/v1/inventory.routes.ts');
const service = read('src/application/inventory/inventory.service.ts');

console.log('\n=== 1. THE FILTERS THE PANEL SENDS ARE ACCEPTED ===');
// The exact class of bug that made requisition products come back empty: the
// client asked for a limit the route's schema refused.
const limitSent = Number(panel.match(/batches\?limit=(\d+)/)?.[1]);
const limitMax = Number(
  routes
    .slice(routes.indexOf("'/batches'"), routes.indexOf("'/batches'") + 600)
    .match(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(\d+\)\.max\((\d+)\)/)?.[1],
);
check('the panel asks for a limit', Number.isFinite(limitSent), String(limitSent));
check('the route declares a maximum', Number.isFinite(limitMax), String(limitMax));
check('and the limit is within it', limitSent <= limitMax, `${limitSent} > ${limitMax}`);

const windows = [...panel.matchAll(/value: '(\d+)'/g)].map((m) => Number(m[1]));
check('expiry windows are offered', windows.length >= 3, String(windows.length));
check('all within the route’s ceiling', windows.every((w) => w >= 0 && w <= 3650));
check('the param name matches the route',
  panel.includes('expiringWithinDays=') && routes.includes('expiringWithinDays:'));
check('warehouse filter matches too',
  panel.includes('warehouseId=') && routes.includes('warehouseId: z.string()'));

console.log('\n=== 2. A FAILED LOAD IS NOT AN ALL-CLEAR ===');
check('load errors are surfaced', panel.includes('query.isError'));
check('and say the list is incomplete', /incomplete/i.test(panel));
check('the empty state only shows once loading finished', panel.includes('!query.isLoading'));

console.log('\n=== 3. THE LIST IS HONEST ABOUT WHAT IT IS ===');
// The batch record tracks arrivals; sales do not pick batches. Presenting it as
// a running balance would be wrong in a way nobody would catch.
check('it is not labelled as remaining stock', !/remaining in batch|on hand/i.test(panel));
check('the column says what arrived', panel.includes('quantityReceived'));
check('and the caveat is stated on the page', /not a running balance/i.test(panel));
check('naming why — sales do not record a batch', /sales do not record which batch/i.test(panel));

console.log('\n=== 4. EXPIRY READS THE WAY SOMEONE WOULD SAY IT ===');
check('overdue batches read as expired', /`Expired \$\{days\} day\$\{.*\} ago`/.test(panel));
check('not as zero days left', panel.includes('Math.abs('));
check('urgency is colour-coded', panel.includes("'error'") && panel.includes("'warning'"));
check('a batch with no expiry is handled', panel.includes("b.expiryDate === null"));
check('and singular days are not "1 days"', (panel.match(/=== 1 \? '' : 's'/g) ?? []).length >= 2);

console.log('\n=== 5. THE UNIT TRAVELS TO EVERY QUANTITY ===');
check('the API returns it on batches', /unit: r\.variant\.product\.unit/.test(service));
check('and on stock levels', /product: \{ select: \{ id: true, name: true, unit: true \} \}/.test(service));
check('the batch table prints it', panel.includes('b.unit ?'));
check('the stock table prints it', inventory.includes('r.variant.product.unit'));
check('the mobile receiving screen prints it', /_kv\('Expected', l\.expected, scheme, l\.unit\)/.test(scan));
check('a missing unit degrades to a bare number',
  panel.includes("b.unit ? ` ${b.unit}` : ''") && /unit == null \|\| unit\.isEmpty/.test(scan));

console.log('\n=== 6. MOBILE CAPTURES BATCH AND EXPIRY ===');
check('there is a batch field per line', /controller: l\.batch/.test(scan));
check('and a date picker for expiry', /showDatePicker|initialDate: l\.expiry/.test(scan));
check('both are posted with the line', /'batchNumber': l\.batchNumber\.trim\(\)/.test(scan) && /'expiryDate': l\.expiry!\.toIso8601String\(\)/.test(scan));
// Optional: most goods do not expire, and a wall of required fields would make
// receiving slower for everyone to serve the minority that needs it.
check('they are omitted when blank, not sent empty',
  /if \(l\.batchNumber\.trim\(\)\.isNotEmpty\)/.test(scan) && /if \(l\.expiry != null\)/.test(scan));
check('the controller is disposed', /l\.batch\.dispose\(\)/.test(scan));

console.log('\n=== 7. THE VIEW IS REACHABLE AND GUARDED ===');
check('a tab exists for it', inventory.includes('Batches & expiry'));
check('the panel is rendered from it', inventory.includes('<ExpiringStockPanel'));
check('the stock tab still renders', inventory.includes("tab === 'batches' ?"));
check('warehouses are shared with the panel', inventory.includes('warehouses={warehousesQuery.data ?? []}'));
check('the endpoint requires inventory.read',
  /'\/batches',\s*\n\s*requirePermission\('inventory\.read'\)/.test(routes));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
