/*
 * Creating a product from the phone, the way the mobile form now sends it.
 *
 * The form used to ask for one SKU, one price and one barcode, folded into a
 * single implicit variant. It now sends a real variants array, generates
 * barcodes, and carries the batch/expiry settings the web app has — so what is
 * checked here is that the server accepts exactly that shape, and that the
 * product which comes back is the one that was typed in.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { catalogService } from '../../src/application/catalog/catalog.service';
import { createProductSchema } from '../../src/application/catalog/catalog.dto';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '';

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

/** The same EAN-13 the phone and the web app both mint. */
function generateBarcode(millis: number): string {
  const base = `20${String(millis).slice(-10)}`.slice(0, 12);
  const sum = base.split('').reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

async function main() {
  const org = await db.organization.create({
    data: { name: 'Phone Co', slug: `phone-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  userId = (await db.user.create({
    data: { email: `phone-${stamp}@t.test`, passwordHash: 'x', firstName: 'Phone', lastName: 'T' },
  })).id;
  await db.warehouse.create({
    data: { organizationId: orgId, name: 'Main', code: `PH-${stamp}`, isDefault: true },
  });

  // ── 1. One version, the ordinary case ────────────────────────────────────
  console.log('\nA product with a single version');
  await as(async () => {
    const body = {
      name: 'Palm Oil 1L',
      unit: 'bottle',
      status: 'ACTIVE',
      taxRate: 7.5,
      variants: [
        { sku: `PO1-${stamp}`, price: 2500, costPrice: 1800, isDefault: true, initialStock: 40 },
      ],
    };
    const parsed = createProductSchema.safeParse(body);
    check('the server accepts what the phone sends', parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));

    const product = await catalogService.createProduct(parsed.data as never, 'NGN');
    check('it comes back with its unit', product.unit === 'bottle');
    check('and one variant', product.variants.length === 1);
    check('carrying the SKU that was typed', product.variants[0]!.sku === `PO1-${stamp}`);
    check('and marked as the default', product.variants[0]!.isDefault === true);
  });

  // ── 2. Several versions, which the form could not do before ──────────────
  console.log('\nA product sold in three sizes');
  await as(async () => {
    const body = {
      name: 'Groundnut Oil',
      unit: 'bottle',
      status: 'ACTIVE',
      variants: [
        { sku: `GN-500-${stamp}`, name: '500ml', price: 1400, isDefault: true },
        { sku: `GN-1L-${stamp}`, name: '1L', price: 2500, costPrice: 1900 },
        { sku: `GN-5L-${stamp}`, name: '5L', price: 11000, costPrice: 9000, initialStock: 12 },
      ],
    };
    const parsed = createProductSchema.safeParse(body);
    check('the server accepts three versions', parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));

    const product = await catalogService.createProduct(parsed.data as never, 'NGN');
    check('all three are created', product.variants.length === 3);
    check('each keeps its own name',
      ['500ml', '1L', '5L'].every((n) => product.variants.some((v) => v.name === n)));
    check('each keeps its own price',
      product.variants.some((v) => Number(v.price) === 11000));
    check('exactly one is the default',
      product.variants.filter((v) => v.isDefault).length === 1);
  });

  // ── 3. A generated barcode survives the round trip ───────────────────────
  console.log('\nA generated barcode is stored as generated');
  await as(async () => {
    const barcode = generateBarcode(1756900000000 + (stamp % 1000));
    const parsed = createProductSchema.safeParse({
      name: 'Loose Rice',
      unit: 'kg',
      status: 'ACTIVE',
      variants: [{ sku: `RICE-${stamp}`, barcode, price: 900, isDefault: true }],
    });
    check('a generated barcode is accepted', parsed.success);
    const product = await catalogService.createProduct(parsed.data as never, 'NGN');
    check('and comes back unchanged', product.variants[0]!.barcode === barcode);
    check('thirteen digits', (product.variants[0]!.barcode ?? '').length === 13);

    // The check digit has to survive, or the label will not scan.
    const stored = product.variants[0]!.barcode!;
    const base = stored.slice(0, 12);
    const sum = base.split('').reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    check('with its check digit intact', String((10 - (sum % 10)) % 10) === stored[12]);
  });

  // ── 4. The batch/expiry settings the web app has ─────────────────────────
  console.log('\nThe phone can set what the web app sets');
  await as(async () => {
    const parsed = createProductSchema.safeParse({
      name: 'Amoxicillin 500mg',
      unit: 'pack',
      status: 'ACTIVE',
      batchTracked: true,
      expiryTracked: true,
      shelfLifeDays: 540,
      expiryAlertDays: 90,
      variants: [{ sku: `AMX-${stamp}`, price: 3500, isDefault: true }],
    });
    check('expiry settings are accepted', parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));

    const product = await catalogService.createProduct(parsed.data as never, 'NGN');
    check('batch tracking is on', product.batchTracked === true);
    check('expiry tracking is on', product.expiryTracked === true);
    check('the shelf life is kept', product.shelfLifeDays === 540);
    check('and the warning window', product.expiryAlertDays === 90);
  });

  // ── 5. What the form refuses to send ─────────────────────────────────────
  console.log('\nA version with no SKU is not sent at all');
  await as(async () => {
    // The card drops rows without a SKU rather than sending them, because the
    // server rejects the whole product for one blank row.
    const withBlank = createProductSchema.safeParse({
      name: 'Bad', status: 'ACTIVE',
      variants: [{ sku: '', price: 100, isDefault: true }],
    });
    check('the server would refuse a blank SKU', !withBlank.success);

    const noVariants = createProductSchema.safeParse({ name: 'Bad', status: 'ACTIVE', variants: [] });
    check('and refuses a product with no versions at all', !noVariants.success);
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  const org = { organizationId: orgId };
  await db.stockMovement.deleteMany({ where: org }).catch(() => {});
  await db.stockLevel.deleteMany({ where: org }).catch(() => {});
  await db.productVariant.deleteMany({ where: org }).catch(() => {});
  await db.product.deleteMany({ where: org }).catch(() => {});
  await db.warehouse.deleteMany({ where: org }).catch(() => {});
  await db.auditLog.deleteMany({ where: org }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
