/**
 * Recipes, production orders and deletion, end to end.
 *
 * Runs against the live dev database with a throwaway organization. Covers the
 * five reported faults and the paths they touch: what the dropdowns actually
 * contain, what a recipe does to the product it is written for, and what the
 * two new deletes refuse.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { catalogService } from '../../src/application/catalog/catalog.service';
import { bomService } from '../../src/application/manufacturing/bom.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '';
let sugarId = '', waterId = '', drinkId = '', crateId = '', bomId = '';
let sugarVariant = '', waterVariant = '', drinkVariant = '';

const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `mfg-${stamp}`, organizationId: orgId, userId }, fn);

/** The list the recipe and production dialogs ask for. */
const makeableList = () => asOrg(() => catalogService.listProducts({
  itemKind: 'PRODUCT', status: 'ACTIVE', subscriptionState: 'active', sort: 'newest', limit: 100,
} as never)) as Promise<{ items: { id: string; name: string }[] }>;

const rawMaterialList = () => asOrg(() => catalogService.listProducts({
  itemKind: 'RAW_MATERIAL', status: 'ACTIVE', subscriptionState: 'active', sort: 'newest', limit: 100,
} as never)) as Promise<{ items: { id: string; name: string }[] }>;

async function main() {
  const org = await db.organization.create({
    data: { name: `Mfg Verify ${stamp}`, slug: `mfg-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `mfg-verify-${stamp}@example.invalid`, firstName: 'Mfg', lastName: 'Verify', passwordHash: 'x' },
  });
  userId = user.id;

  const make = async (name: string, sku: string, type: 'RAW_MATERIAL' | null) => {
    const p = await asOrg(() => catalogService.createProduct({
      name, status: 'ACTIVE', taxRate: 0, unit: 'kg',
      ...(type ? { manufacturingType: type } : {}),
      variants: [{ sku, price: 100, isDefault: true, initialStock: 50 }],
    } as never, 'NGN')) as Record<string, unknown>;
    return { id: String(p.id), variantId: String((p.variants as { id: string }[])[0]!.id) };
  };

  // ── 1. What the recipe dialog offers ────────────────────────────────────
  console.log('\nRecipe creation: what can be made');
  const sugar = await make(`Sugar ${stamp}`, `RM-SUG-${stamp}`, 'RAW_MATERIAL');
  const water = await make(`Treated Water ${stamp}`, `RM-WAT-${stamp}`, 'RAW_MATERIAL');
  const drink = await make(`Citra Lime ${stamp}`, `FG-CIT-${stamp}`, null);
  const crate = await make(`Crate ${stamp}`, `FG-CRT-${stamp}`, null);
  sugarId = sugar.id; waterId = water.id; drinkId = drink.id; crateId = crate.id;
  sugarVariant = sugar.variantId; waterVariant = water.variantId; drinkVariant = drink.variantId;

  const makeable = await makeableList();
  check('products to make are listed', makeable.items.length >= 2, `got ${makeable.items.length}`);
  check('the finished product is among them', makeable.items.some((p) => p.id === drinkId));
  check('a raw material is not offered as something to make',
    !makeable.items.some((p) => p.id === sugarId || p.id === waterId));

  /*
   * The regression that caused the empty dropdown: these products have
   * manufacturingEnabled false, which is the default, and the dialog used to
   * require it to be true before a recipe could be written for them.
   */
  const fresh = await db.product.findUniqueOrThrow({ where: { id: drinkId }, select: { manufacturingEnabled: true } });
  check('and they are listed even though manufacturingEnabled is still false',
    fresh.manufacturingEnabled === false && makeable.items.some((p) => p.id === drinkId));

  // ── 2. What the component dropdown offers ───────────────────────────────
  console.log('\nComponents: raw materials by default');
  const materials = await rawMaterialList();
  check('raw materials are listed as components', materials.items.length === 2, `got ${materials.items.length}`);
  check('a finished product is not among them by default',
    !materials.items.some((p) => p.id === drinkId || p.id === crateId));
  const everything = await asOrg(() => catalogService.listProducts({
    itemKind: 'ALL', status: 'ACTIVE', subscriptionState: 'active', sort: 'newest', limit: 100,
  } as never)) as { items: { id: string }[] };
  check('turning the toggle on brings products in too',
    everything.items.length > materials.items.length
    && everything.items.some((p) => p.id === drinkId));

  // ── 3. Writing the recipe ───────────────────────────────────────────────
  console.log('\nWriting a recipe');
  const bom = await asOrg(() => bomService.create({
    productId: drinkId, outputQuantity: 1000, notes: null,
    items: [
      { variantId: sugarVariant, quantity: 120, unit: 'kg', scrapPercent: 2 },
      { variantId: waterVariant, quantity: 800, unit: 'kg', scrapPercent: 0 },
    ],
  } as never)) as { id: string; bomNumber: string };
  bomId = bom.id;
  check('the recipe is created', Boolean(bom.id));

  const after = await db.product.findUniqueOrThrow({ where: { id: drinkId }, select: { manufacturingEnabled: true } });
  check('writing it marks the product as something the business makes', after.manufacturingEnabled === true);

  let rawOutput = '';
  await asOrg(async () => {
    try {
      await bomService.create({
        productId: sugarId, outputQuantity: 10, notes: null,
        items: [{ variantId: waterVariant, quantity: 1, unit: 'kg', scrapPercent: 0 }],
      } as never);
    } catch (err) { rawOutput = (err as Error).message; }
  });
  check('a raw material still cannot be the output of a recipe', /raw material/i.test(rawOutput), rawOutput);

  // ── 4. The production order dropdown ────────────────────────────────────
  console.log('\nProduction order: what to make');
  const forProduction = await makeableList();
  check('the dropdown is not empty', forProduction.items.length >= 2, `got ${forProduction.items.length}`);
  check('the product with a recipe is in it', forProduction.items.some((p) => p.id === drinkId));
  const activeBom = await asOrg(() => bomService.activeFor(drinkId));
  check('its recipe is not active until activated', activeBom === null);
  await asOrg(() => bomService.activate(bomId));
  const nowActive = await asOrg(() => bomService.activeFor(drinkId)) as { id: string } | null;
  check('and is found once activated', nowActive?.id === bomId);

  const requirements = await asOrg(() => bomService.requirementsFor(bomId, 2000)) as { items: { requiredQuantity: number }[] };
  check('requirements scale with the batch', requirements.items.length === 2);
  // 120kg per 1,000 at 2% scrap, doubled → 244.8
  const sugarNeeded = requirements.items.find((i) => Math.abs(i.requiredQuantity - 244.8) < 0.01);
  check('and are grossed up by scrap', Boolean(sugarNeeded),
    JSON.stringify(requirements.items.map((i) => i.requiredQuantity)));

  // ── 5. Deleting a recipe ────────────────────────────────────────────────
  console.log('\nDeleting a recipe');
  const spare = await asOrg(() => bomService.create({
    productId: crateId, outputQuantity: 1, notes: null,
    items: [{ variantId: waterVariant, quantity: 1, unit: 'kg', scrapPercent: 0 }],
  } as never)) as { id: string; bomNumber: string };

  const crateBefore = await db.product.findUniqueOrThrow({ where: { id: crateId }, select: { manufacturingEnabled: true } });
  check('the second product is now marked as made', crateBefore.manufacturingEnabled === true);

  await asOrg(() => bomService.remove(spare.id));
  check('the recipe is gone', (await db.billOfMaterial.count({ where: { id: spare.id } })) === 0);
  check('and its component lines went with it',
    (await db.billOfMaterialItem.count({ where: { bomId: spare.id } })) === 0);
  const crateAfter = await db.product.findUniqueOrThrow({ where: { id: crateId }, select: { manufacturingEnabled: true } });
  check('deleting the last recipe stops the product being listed as made',
    crateAfter.manufacturingEnabled === false);

  // A recipe a production order cites must not be deletable.
  const warehouse = await db.warehouse.findFirstOrThrow({ where: { organizationId: orgId }, select: { id: true } });
  const order = await db.productionOrder.create({
    data: {
      organizationId: orgId, orderNumber: `PO-${stamp}`, productId: drinkId, bomId,
      plannedQuantity: 1000, warehouseId: warehouse.id, status: 'DRAFT',
    },
  });
  let refusal = '';
  await asOrg(async () => {
    try { await bomService.remove(bomId); }
    catch (err) { refusal = (err as Error).message; }
  });
  check('a recipe used by a production order is refused', /production order/i.test(refusal), refusal);
  check('and the recipe survives the refusal', (await db.billOfMaterial.count({ where: { id: bomId } })) === 1);

  // ── 6. Permanently deleting a product ───────────────────────────────────
  console.log('\nPermanently deleting a product');
  let notArchived = '';
  await asOrg(async () => {
    try { await catalogService.purgeProduct(crateId); }
    catch (err) { notArchived = (err as Error).message; }
  });
  check('an active product cannot be permanently deleted', /archived/i.test(notArchived), notArchived);

  // Stock on hand must block — deleting a product sitting on a shelf loses it.
  await asOrg(() => catalogService.deleteProduct(crateId));
  const withStock = await asOrg(() => catalogService.purgePreflight(crateId));
  check('a product still holding stock is refused',
    withStock.canPurge === false && withStock.blockedBy.some((b) => /stock on hand/i.test(b.reason)),
    JSON.stringify(withStock.blockedBy));

  // Clear the shelf, and it becomes deletable — its movement history is its
  // own bookkeeping and goes with it.
  await db.stockLevel.updateMany({
    where: { variant: { productId: crateId } },
    data: { quantity: 0, reserved: 0 },
  });
  const archivedCheck = await asOrg(() => catalogService.purgePreflight(crateId));
  check('once archived and empty it reports as deletable', archivedCheck.canPurge === true, JSON.stringify(archivedCheck.blockedBy));
  check('and says what goes with it', archivedCheck.alsoRemoved.variants === 1);

  await asOrg(() => catalogService.purgeProduct(crateId));
  check('the product is gone for good', (await db.product.count({ where: { id: crateId } })) === 0);
  check('its variants went too', (await db.productVariant.count({ where: { productId: crateId } })) === 0);

  // One that is referenced must be refused, with the reason named.
  await asOrg(() => catalogService.deleteProduct(sugarId));
  const blocked = await asOrg(() => catalogService.purgePreflight(sugarId));
  check('a material used in a recipe is reported as blocked', blocked.canPurge === false);
  check('and the reason names the recipe',
    blocked.blockedBy.some((b) => /recipe/i.test(b.reason)), JSON.stringify(blocked.blockedBy));
  let blockedMessage = '';
  await asOrg(async () => {
    try { await catalogService.purgeProduct(sugarId); }
    catch (err) { blockedMessage = (err as Error).message; }
  });
  check('deleting it is refused', /cannot be permanently deleted/i.test(blockedMessage), blockedMessage);
  check('and it is still there', (await db.product.count({ where: { id: sugarId } })) === 1);

  await db.productionOrder.delete({ where: { id: order.id } });

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function cleanup() {
  if (!orgId) return;
  const steps: [string, () => Promise<unknown>][] = [
    ['productionOrder', () => db.productionOrder.deleteMany({ where: { organizationId: orgId } })],
    ['bomItem', () => db.billOfMaterialItem.deleteMany({ where: { organizationId: orgId } })],
    ['bom', () => db.billOfMaterial.deleteMany({ where: { organizationId: orgId } })],
    ['stockMovement', () => db.stockMovement.deleteMany({ where: { organizationId: orgId } })],
    ['stockLevel', () => db.stockLevel.deleteMany({ where: { organizationId: orgId } })],
    ['variant', () => db.productVariant.deleteMany({ where: { product: { organizationId: orgId } } })],
    ['product', () => db.product.deleteMany({ where: { organizationId: orgId } })],
    ['warehouse', () => db.warehouse.deleteMany({ where: { organizationId: orgId } })],
    ['org', () => db.organization.deleteMany({ where: { id: orgId } })],
    ['user', () => db.user.deleteMany({ where: { id: userId } })],
  ];
  for (const [name, run] of steps) {
    try { await run(); } catch (err) { console.log(`  (cleanup: ${name} — ${(err as Error).message.split('\n')[0].slice(0, 90)})`); }
  }
}

main()
  .catch((err) => { failed++; console.error('\nFATAL', err); })
  .finally(async () => { await cleanup(); await db.$disconnect(); process.exit(failed === 0 ? 0 : 1); });
