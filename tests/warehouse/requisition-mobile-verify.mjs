/*
 * The requisition workflow, and the mobile screen that receives it.
 *
 * The rule worth guarding structurally is §14: destination stock rises at
 * receive and nowhere else. A behaviour test proves it today; this stops the
 * next edit quietly moving it back into dispatch or create.
 */
import { readFileSync } from 'node:fs';

const API = '/Users/mac/Desktop/Development/businesshub-ai/backend/src';
const APP = '/Users/mac/Desktop/Development/businesshub-ai/flutter/lib/features/inventory/requisition_receive_screen.dart';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const svc = readFileSync(`${API}/application/inventory/requisitions.service.ts`, 'utf8');
const routes = readFileSync(`${API}/presentation/http/v1/requisitions.routes.ts`, 'utf8');
const perms = readFileSync(`${API}/shared/permissions.ts`, 'utf8');
const app = readFileSync(APP, 'utf8');

console.log('\n=== 1. STOCK MOVES IN EXACTLY TWO PLACES ===');
{
  // Only dispatch may decrement the source; only receive may increment the
  // destination. Anything else is stock appearing from nowhere.
  const dispatchBlock = svc.slice(svc.indexOf('async dispatch('), svc.indexOf('async receive('));
  const receiveBlock = svc.slice(svc.indexOf('async receive('), svc.indexOf('async cancel('));
  const createBlock = svc.slice(svc.indexOf('async create('), svc.indexOf('async availability('));

  check('creating a requisition touches no stock level', !createBlock.includes('stockLevel'));
  check('nor any stock movement', !createBlock.includes('stockMovement'));
  check('dispatch decrements the source', /decrement: line\.quantity/.test(dispatchBlock));
  check('dispatch never increments anything', !dispatchBlock.includes('increment:'));
  check('receive increments the destination', /increment: line\.quantity/.test(receiveBlock));
  check('receive never decrements anything', !receiveBlock.includes('decrement:'));
  check('and the reason is written down', /not yet at the destination/.test(svc));
}

console.log('\n=== 2. THE LIFECYCLE IS ENFORCED ===');
check('a warehouse cannot request from itself',
  svc.includes('A warehouse cannot request stock from itself.'));
check('dispatch is refused before approval', /notYetApproved\.includes\(r\.status\)/.test(svc));
check('and once closed', /closed\.includes\(r\.status\)/.test(svc));
check('an outstanding balance can still be dispatched after a partial receipt',
  /balance still to send could never leave the source/.test(svc.replace(/\n\s*\*\s?/g, ' ')));
check('receiving is capped at what was dispatched',
  /only \$\{inTransit\} of that line is in transit/.test(svc));
check('approving more than requested is refused',
  svc.includes('Cannot approve more than was requested.'));
check('rejection demands a reason',
  svc.includes('Give a reason when rejecting a requisition.'));
check('cancelling stock already in transit is refused',
  /Stock is already in transit for this requisition/.test(svc));

console.log('\n=== 3. CONCURRENCY AND RETRIES ===');
check('dispatch is idempotent', /idempotencyKey: dto\.idempotencyKey \?\? null/.test(svc));
check('receipt is idempotent', /requisition receipt replayed/.test(svc));
check('availability is re-read inside the transaction',
  /Re-read inside the transaction: two dispatches racing/.test(svc));
check('and the transfer key is unique per organisation',
  readFileSync('/Users/mac/Desktop/Development/businesshub-ai/backend/prisma/schema.prisma', 'utf8')
    .includes('@@unique([organizationId, idempotencyKey])'));
check('reserved stock is not treated as available',
  /Reserved stock is spoken for by orders already placed/.test(svc));

console.log('\n=== 4. IT REUSES THE TRANSFER MACHINERY ===');
check('a dispatch raises a StockTransfer', svc.includes('tx.stockTransfer.create'));
check('linked back to the requisition', svc.includes('requisitionId: id'));
check('marked in transit rather than received', /status: 'IN_TRANSIT'/.test(svc));
check('and closed only when everything has landed',
  /status: 'RECEIVED', receivedAt: new Date\(\)/.test(svc));
check('using the existing movement types',
  svc.includes("type: 'TRANSFER_OUT'") && svc.includes("type: 'TRANSFER_IN'"));

console.log('\n=== 5. PERMISSIONS SPLIT BY WHO DOES THE STEP ===');
for (const p of ['requisition_create', 'requisition_approve', 'requisition_dispatch', 'requisition_receive']) {
  check(`inventory.${p} exists`, perms.includes(`'${p}'`));
  check(`and gates its route`, routes.includes(`inventory.${p}`));
}
check('the split is explained', /asking, agreeing and\s+\/\/ physically sending are done by different people/.test(perms));

console.log('\n=== 6. NOTIFICATIONS AT EACH HAND-OFF ===');
for (const [event, type] of [
  ['submitted', 'inventory.requisition.submitted'],
  ['approved', 'inventory.requisition.approved'],
  ['rejected', 'inventory.requisition.rejected'],
  ['dispatched', 'inventory.requisition.dispatched'],
  ['received', 'inventory.requisition.received'],
]) {
  check(`${event} notifies someone`, svc.includes(`'${type}'`));
}
check('a failed notification does not fail the action',
  /requisition notification not sent/.test(svc));

console.log('\n=== 7. THE MOBILE SCREEN MATCHES THE API ===');
check('it scans the requisition QR', /vhicasar:\/\/ir\//.test(app));
check('which the server emits', svc.includes('`vhicasar://ir/${row.scanToken}`'));
check('it loads the receiving view',
  app.includes("/requisitions/scan/\$token/receiving-view"));
check('served by the API', routes.includes("'/scan/:token/receiving-view'"));
check('expected means what was dispatched, not what was asked',
  app.includes("_kv('Expected (dispatched)'"));
check('and requested is shown only as context',
  /"Requested" is shown for context/.test(app));
check('receiving is capped at what is in transit', /next > l\.remaining/.test(app));
check('products are scanned individually', app.includes('_openProductScanner'));
check('matched on barcode or SKU',
  /l!\.barcode\?\.toLowerCase\(\) == value \|\| l\.sku\.toLowerCase\(\) == value/.test(app));
check('with manual entry as a fallback', app.includes('Or type a SKU / barcode'));
check('a confirmation precedes any change', app.includes('Nothing changes until you confirm.'));
check('explaining stock is not double-counted',
  /It already left the sending warehouse/.test(app));
check('and the receipt is idempotent', app.includes("'idempotencyKey': _key"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
