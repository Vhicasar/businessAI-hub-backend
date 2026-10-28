/**
 * Products and raw materials stay on their own side of the line.
 *
 * The reported fault: raw materials imported from the Raw Materials page came
 * out as ordinary products. The cause was that the importer was told "products"
 * whatever page it was launched from, and the importer sets no manufacturing
 * type. These checks cover the whole round trip, plus a sweep for the same
 * mistake anywhere else.
 */
import { readFileSync } from 'node:fs';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { importEntity, exportEntity } from '../../src/application/data-transfer/data-transfer.service';
import { catalogService } from '../../src/application/catalog/catalog.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '';
const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `rm-${stamp}`, organizationId: orgId, userId }, fn);

const list = (itemKind: 'PRODUCT' | 'RAW_MATERIAL') => asOrg(() => catalogService.listProducts({
  itemKind, subscriptionState: 'active', sort: 'newest', limit: 100,
} as never)) as Promise<{ items: { id: string; name: string }[] }>;

async function main() {
  const org = await db.organization.create({
    data: { name: `RM Verify ${stamp}`, slug: `rm-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `rm-verify-${stamp}@example.invalid`, firstName: 'RM', lastName: 'Verify', passwordHash: 'x' },
  });
  userId = user.id;

  // ── Importing raw materials ─────────────────────────────────────────────
  console.log('\nImporting as raw materials');
  const csv = `name,sku,price\nCane Sugar ${stamp},RM-SUG-${stamp},0\nTreated Water ${stamp},RM-WAT-${stamp},0\n`;
  const result = await asOrg(() => importEntity('raw-materials', csv));
  check('both rows import', result.created === 2, JSON.stringify({ created: result.created, errors: result.errors }));

  const materials = await list('RAW_MATERIAL');
  check('they appear under raw materials', materials.items.length === 2, `got ${materials.items.length}`);

  const products = await list('PRODUCT');
  check('and not under products', products.items.length === 0, `got ${products.items.length}`);

  const rows = await db.product.findMany({
    where: { organizationId: orgId }, select: { manufacturingType: true, sellable: true },
  });
  check('each is typed as a raw material', rows.every((r) => r.manufacturingType === 'RAW_MATERIAL'));
  check('and is not offered for sale', rows.every((r) => r.sellable === false));

  // ── Importing products ──────────────────────────────────────────────────
  console.log('\nImporting as products');
  const prodCsv = `name,sku,price\nBottled Lime ${stamp},FG-LIM-${stamp},450\n`;
  const prodResult = await asOrg(() => importEntity('products', prodCsv));
  check('the product imports', prodResult.created === 1, JSON.stringify(prodResult.errors));
  const nowProducts = await list('PRODUCT');
  check('it lands under products', nowProducts.items.length === 1);
  const nowMaterials = await list('RAW_MATERIAL');
  check('and raw materials are untouched', nowMaterials.items.length === 2);

  // ── Exporting ───────────────────────────────────────────────────────────
  console.log('\nExporting each kind');
  const rmExport = await asOrg(() => exportEntity('raw-materials'));
  check('the raw-material export names itself', rmExport.filename.startsWith('raw-materials-'), rmExport.filename);
  check('it contains the materials', rmExport.csv.includes(`RM-SUG-${stamp}`) && rmExport.csv.includes(`RM-WAT-${stamp}`));
  check('and not the product', !rmExport.csv.includes(`FG-LIM-${stamp}`));

  const prodExport = await asOrg(() => exportEntity('products'));
  check('the product export contains the product', prodExport.csv.includes(`FG-LIM-${stamp}`));
  check('and not the materials', !prodExport.csv.includes(`RM-SUG-${stamp}`));

  // A file exported from one side must re-import to the same side.
  console.log('\nA round trip keeps the kind');
  // Clear the materials, variants and stock first — the product row cannot go
  // while anything still points at it.
  const doomed = await db.product.findMany({
    where: { organizationId: orgId, manufacturingType: 'RAW_MATERIAL' }, select: { id: true },
  });
  const doomedIds = doomed.map((d) => d.id);
  await db.stockMovement.deleteMany({ where: { variant: { productId: { in: doomedIds } } } });
  await db.stockLevel.deleteMany({ where: { variant: { productId: { in: doomedIds } } } });
  await db.productVariant.deleteMany({ where: { productId: { in: doomedIds } } });
  await db.product.deleteMany({ where: { id: { in: doomedIds } } });
  const reimport = await asOrg(() => importEntity('raw-materials', rmExport.csv));
  check('the exported file re-imports', reimport.created >= 1, JSON.stringify(reimport.errors));
  const backAgain = await list('RAW_MATERIAL');
  check('and comes back as raw materials', backAgain.items.length >= 1);
  const stillOneProduct = await list('PRODUCT');
  check('without adding to products', stillOneProduct.items.length === 1, `got ${stillOneProduct.items.length}`);

  // ── The same mistake, anywhere else ─────────────────────────────────────
  console.log('\nNowhere else hardcodes the kind');
  const productsPage = readFileSync('../web/src/features/catalog/ProductsPage.tsx', 'utf8');
  check('the shared catalogue page does not hardcode an import entity',
    !/ImportExportButton entity="products"/.test(productsPage),
    'ImportExportButton is pinned to "products" on a page that also serves raw materials');
  check('it chooses the entity from the page it is on',
    /entity=\{rawMaterials \? 'raw-materials' : 'products'\}/.test(productsPage));

  const transferSrc = readFileSync('src/application/data-transfer/data-transfer.service.ts', 'utf8');
  check('the importer sets a manufacturing type',
    transferSrc.includes("manufacturingType: 'RAW_MATERIAL'"));
  check('and the exporter filters by kind',
    /productKindWhere\(entity === 'raw-materials'/.test(transferSrc));

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function cleanup() {
  if (!orgId) return;
  for (const run of [
    () => db.stockMovement.deleteMany({ where: { organizationId: orgId } }),
    () => db.stockLevel.deleteMany({ where: { organizationId: orgId } }),
    () => db.productVariant.deleteMany({ where: { product: { organizationId: orgId } } }),
    () => db.product.deleteMany({ where: { organizationId: orgId } }),
    () => db.warehouse.deleteMany({ where: { organizationId: orgId } }),
    () => db.organization.deleteMany({ where: { id: orgId } }),
    () => db.user.deleteMany({ where: { id: userId } }),
  ]) await run().catch(() => undefined);
}

main()
  .catch((err) => { failed++; console.error('\nFATAL', err); })
  .finally(async () => { await cleanup(); await db.$disconnect(); process.exit(failed === 0 ? 0 : 1); });
