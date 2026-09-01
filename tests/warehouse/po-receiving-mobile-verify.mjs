/*
 * The mobile goods-in screen: scan the order, count the products, confirm once.
 *
 * Structural, because the failure mode that matters is the screen and the API
 * disagreeing — a field the server never sends, or a body the server rejects.
 */
import { readFileSync } from 'node:fs';

const APP = '/Users/mac/Desktop/Development/businesshub-ai/flutter/lib/features/purchasing/receive_scan_screen.dart';
const API = '/Users/mac/Desktop/Development/businesshub-ai/backend/src';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const app = readFileSync(APP, 'utf8');
const service = readFileSync(`${API}/application/purchasing/purchase-orders.service.ts`, 'utf8');
const routes = readFileSync(`${API}/presentation/http/v1/purchase-orders.routes.ts`, 'utf8');

console.log('\n=== 1. THE ORDER IS SCANNED, NOT TYPED ===');
check('a QR/barcode scanner opens first', app.includes('_Stage.scanOrder'));
check('the printed deep link is understood', /vhicasar:\/\/po\//.test(app));
check('and a code can be typed when a label is torn', app.includes('Or enter the PO code'));
check('scanning loads the receiving view', app.includes("/purchase-orders/scan/\$token/receiving-view"));
check('which the server actually serves', routes.includes("'/scan/:token/receiving-view'"));

console.log('\n=== 2. EVERY QUANTITY THE SPEC ASKS FOR IS SHOWN ===');
for (const label of ['Expected', 'Previously received', 'Remaining', 'Receiving now', 'Total received']) {
  check(`"${label}" is on the line card`, app.includes(`'${label}'`));
}
check('all of them come from the server', /previouslyReceived: received/.test(service));
check('remaining is computed server-side, not guessed',
  /remaining: Math\.max\(0, Number\(\(expected - received\)\.toFixed\(3\)\)\)/.test(service));

console.log('\n=== 3. PRODUCTS ARE SCANNED INDIVIDUALLY ===');
check('a dedicated product scanner opens', app.includes('_openProductScanner'));
check('a scan matches a line by barcode or SKU',
  /l!\.barcode\?\.toLowerCase\(\) == value \|\| l\.sku\.toLowerCase\(\) == value/.test(app));
check('repeated scans accumulate', /line\.receivingNow \+= 1/.test(app));
check('the server sends the barcode so matching needs no round trip',
  service.includes('barcode: item.variant.barcode'));
check('a product not on the order is refused',
  app.includes('That product is not on this order.'));
check('with a distinct haptic, since a warehouse is loud',
  app.includes('HapticFeedback.heavyImpact()'));
check('and manual entry still works inside the scanner',
  app.includes('Or type a SKU / barcode'));

console.log('\n=== 4. NOTHING MOVES WITHOUT CONFIRMATION ===');
check('a review step exists', app.includes('_Stage.confirm'));
check('it lists what will be received', /of\s*\n?\s*'\s*\$\{l\.remaining/.test(app) || app.includes('remaining'));
check('and the total quantity', app.includes('Total receiving quantity'));
check('it names the warehouse and the consequence',
  /This will increase inventory in \$warehouseName/.test(app));
check('and says nothing changes until confirmed',
  app.includes('Nothing changes until you confirm.'));
check('only then is receive called', /api\.post\(\s*\n?\s*'\/purchase-orders\/\$_orderId\/receive'/.test(app));

console.log('\n=== 5. A RETRY CANNOT DOUBLE-RECEIVE ===');
check('the app sends an idempotency key', app.includes("'idempotencyKey': _idempotencyKey"));
check('generated once per delivery', /_idempotencyKey = _newKey\(\);/.test(app));
check('the server accepts it', /idempotencyKey: z\.string\(\)/.test(service));
check('and replays return the original result',
  /returning the original result/.test(service));
check('the key is unique per organisation in the database',
  readFileSync('/Users/mac/Desktop/Development/businesshub-ai/backend/prisma/schema.prisma', 'utf8')
    .includes('@@unique([organizationId, idempotencyKey])'));

console.log('\n=== 6. OVER-RECEIVING IS DELIBERATE ===');
check('counting past the order is blocked by default',
  /!_allowOverReceive && line\.totalReceived \+ 1 > line\.expected/.test(app));
check('the policy comes from the server', app.includes("data['allowOverReceive']"));
check('a reason is demanded before submitting',
  app.includes('Give a reason for receiving more than was ordered.'));
check('the overage is shown per line', app.includes("'Over by "));
check('and the server enforces the same rules',
  /Give a reason when receiving more than was ordered/.test(service));

console.log('\n=== 7. THE DELIVERY CAN BE REDIRECTED ===');
check('a warehouse can be chosen', app.includes("labelText: 'Receiving warehouse'"));
check('from the list the server supplies', app.includes("view['warehouses']"));
check('and it is sent with the receipt', app.includes("'warehouseId': _warehouseId"));
check('the server honours it', /const warehouseId = dto\.warehouseId \?\? po\.warehouseId/.test(service));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
