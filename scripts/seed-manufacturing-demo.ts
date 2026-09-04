/**
 * A worked example of the Manufacturing & Operations module.
 *
 * Builds one fictional beverage manufacturer whose records are *connected*:
 * a plan that became an order, an order short of sugar that became a purchase
 * order, a delivery that became stock, stock that was issued to a line, a run
 * that produced a batch, a batch that passed inspection and reached the
 * finished store. Following any one record leads to the next, which is the
 * only way to see whether the module actually holds together.
 *
 *   npx tsx scripts/seed-manufacturing-demo.ts [--slug my-demo] [--reset]
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Everything below is invented for demonstration. The company, its people,
 * its suppliers, its recipes and every quantity are fictional. Product names
 * that resemble real brands are placeholders in a sample data set and are not
 * anybody's actual formulations, costs or operational data.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { prismaUnscoped as db } from '../src/infrastructure/database/prisma';
import { requestContext } from '../src/shared/context';
import { SYSTEM_ROLE_TEMPLATES } from '../src/shared/permissions';
import { hashPassword } from '../src/shared/crypto';

const args = process.argv.slice(2);
const slugFlag = args.indexOf('--slug');
const SLUG = slugFlag >= 0 ? args[slugFlag + 1]! : 'sevenup-demo';
const RESET = args.includes('--reset');
/** Tear the demo down and stop, without building it again. */
const REMOVE = args.includes('--remove');

/**
 * The demo account's password.
 *
 * Real, hashed, and printed at the end — a demo nobody can sign into is a
 * database fixture, not a demonstration. Overridable so a shared environment
 * is not seeded with a password written in a public repository.
 */
const passwordFlag = args.indexOf('--password');
const PASSWORD = passwordFlag >= 0 ? args[passwordFlag + 1]! : 'DemoFactory!2026';

const DISCLAIMER =
  'Demonstration data. This company, its suppliers, recipes, costs and ' +
  'production records are fictional and are not any real business’s data.';

let orgId = '';
let userId = '';
const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);

/**
 * The supplier's lot on the sugar delivery.
 *
 * Shared between the goods receipt and what production consumed, because that
 * shared string is the only thing tying a case on a shelf back to the company
 * that sold us the ingredient.
 */
const SUGAR_LOT = 'PSI-SUG-2026-0418';

async function main() {
  console.log(`\n${DISCLAIMER}\n`);

  if (REMOVE) {
    await wipe();
    console.log(`Removed the "${SLUG}" demo.`);
    return;
  }
  if (RESET) await wipe();

  const existing = await db.organization.findFirst({ where: { slug: SLUG } });
  if (existing && !RESET) {
    console.error(
      `"${SLUG}" already exists. Re-run with --reset to rebuild it, or --slug to use another name.`,
    );
    process.exit(1);
  }

  // ── The business ─────────────────────────────────────────────────────────
  const org = await db.organization.create({
    data: {
      name: 'SevenUp Refreshments Manufacturing Ltd (Demo)',
      slug: SLUG,
      // FOOD gets the manufacturing module from its business type alone, with
      // no override needed — which is the point worth demonstrating.
      businessType: 'FOOD',
      status: 'ACTIVE',
      currency: 'NGN',
      country: 'NG',
      city: 'Lagos',
      settings: { demo: true, disclaimer: DISCLAIMER },
    },
  });
  orgId = org.id;

  const user = await db.user.create({
    data: {
      email: `demo+${SLUG}@vhicasar.test`,
      // Hashed the same way a real sign-up is, so this account actually works.
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Amaka',
      lastName: 'Okafor',
      emailVerifiedAt: new Date(),
    },
  });
  userId = user.id;

  // A real role from the catalogue, so permissions behave as they would live.
  const template = SYSTEM_ROLE_TEMPLATES['Manufacturing Admin']!;
  const role = await db.role.create({
    data: { organizationId: orgId, name: 'Manufacturing Admin', isSystem: true },
  });
  const permissions = await db.permission.findMany({
    where: { key: { in: template.permissions } },
    select: { id: true },
  });
  await db.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  await db.membership.create({
    data: { organizationId: orgId, userId, roleId: role.id, isActive: true, isOwner: true },
  });
  console.log(`Business  ${org.name}`);

  // ── Warehouses (§33) ─────────────────────────────────────────────────────
  const warehouses = await seedWarehouses();
  console.log(`Warehouses ${Object.keys(warehouses).length}`);

  // ── Categories and products ──────────────────────────────────────────────
  const { materials, packaging, finished, spares } = await seedProducts();
  console.log(
    `Products  ${materials.length} raw, ${packaging.length} packaging, ` +
      `${finished.length} finished, ${spares.length} spare`,
  );

  // ── Suppliers ────────────────────────────────────────────────────────────
  const suppliers = await seedSuppliers([...materials, ...packaging, ...spares]);
  console.log(`Suppliers ${suppliers.length}`);

  // ── Lines and equipment ──────────────────────────────────────────────────
  const lines = await seedLines();
  const equipment = await seedEquipment(lines);
  console.log(`Lines     ${lines.length}, equipment ${equipment.length}`);

  await seedMaintenance(equipment, spares, warehouses.maintenance.id);
  console.log('Maintenance completed / scheduled / breakdown');

  // ── Opening stock ────────────────────────────────────────────────────────
  await seedOpeningStock(materials, packaging, spares, warehouses);
  console.log('Opening stock booked in');

  // ── Recipes ──────────────────────────────────────────────────────────────
  const boms = await seedBoms(finished, materials, packaging, warehouses.finishedLagos.id);
  console.log(`Recipes   ${boms.length}`);

  // ── Purchase orders in four states (§33) ─────────────────────────────────
  await seedPurchaseOrders(suppliers, materials, packaging, warehouses.rawMaterials.id);
  console.log('Purchase orders: received / partial / pending / overdue');

  // ── The connected workflow (§34) ─────────────────────────────────────────
  await seedWorkflow({ finished, materials, boms, lines, warehouses });
  console.log('Production: planned / in progress / completed / cancelled');
  console.log('Quality: passed / failed / quarantined');
  console.log('Requisitions: pending / approved / partially issued / fully issued');

  console.log(`\nDone. Open the business with slug "${SLUG}".`);
  console.log('\nSign in with');
  console.log(`  email     ${user.email}`);
  console.log(`  password  ${PASSWORD}`);
  console.log('  role      Manufacturing Admin (full manufacturing access)');
  console.log('\nChange it with --password if this is a shared environment.');
  console.log(`${DISCLAIMER}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function seedWarehouses() {
  const make = (name: string, code: string, warehouseType: string, isDefault = false) =>
    db.warehouse.create({
      data: { organizationId: orgId, name, code, warehouseType: warehouseType as never, isDefault, city: 'Lagos' },
    });

  const [rawMaterials, packaging, wip, finishedLagos, finishedEnugu, maintenance, quarantine] =
    await Promise.all([
      make('Lagos Raw Materials', 'LAG-RAW', 'RAW_MATERIAL', true),
      make('Lagos Packaging', 'LAG-PKG', 'PACKAGING'),
      make('Lagos WIP', 'LAG-WIP', 'WORK_IN_PROGRESS'),
      make('Lagos Finished Goods', 'LAG-FG', 'FINISHED_GOODS'),
      make('Enugu Finished Goods', 'ENU-FG', 'FINISHED_GOODS'),
      make('Maintenance Store', 'MNT-STR', 'SPARE_PARTS'),
      make('QC Quarantine', 'QC-QTN', 'QUARANTINE'),
    ]);
  return { rawMaterials, packaging, wip, finishedLagos, finishedEnugu, maintenance, quarantine };
}

interface SeededProduct {
  productId: string;
  variantId: string;
  name: string;
  unit: string;
  cost: number;
}

async function seedProducts() {
  const category = async (name: string) =>
    db.productCategory.create({
      data: { organizationId: orgId, name, slug: `${slugify(name)}-${Date.now()}` },
    });

  const [rawCat, pkgCat, fgCat, spareCat] = await Promise.all([
    category('Raw Materials'),
    category('Packaging'),
    category('Finished Goods'),
    category('Spare Parts'),
  ]);

  const make = async (
    name: string,
    sku: string,
    unit: string,
    cost: number,
    type: string,
    categoryId: string,
    extra: Record<string, unknown> = {},
  ): Promise<SeededProduct> => {
    const product = await db.product.create({
      data: {
        organizationId: orgId,
        categoryId,
        name,
        slug: `${slugify(name)}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'ACTIVE',
        unit,
        manufacturingType: type as never,
        standardCost: cost,
        ...extra,
      },
    });
    const variant = await db.productVariant.create({
      data: {
        organizationId: orgId,
        productId: product.id,
        sku,
        price: (extra.sellable as boolean) === false ? 0 : Math.round(cost * 1.6),
        costPrice: cost,
        isDefault: true,
      },
    });
    return { productId: product.id, variantId: variant.id, name, unit, cost };
  };

  const rawOpts = { sellable: false, purchaseEnabled: true, batchTracked: true, expiryTracked: true };
  const materials = [
    await make('Refined Sugar', 'RM-SUGAR', 'kg', 850, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 5000, minStock: 10000 }),
    await make('Beverage Concentrate — Lemon Lime', 'RM-CONC-LL', 'L', 12500, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 200 }),
    await make('Beverage Concentrate — Cola', 'RM-CONC-CO', 'L', 13200, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 200 }),
    await make('Beverage Concentrate — Orange', 'RM-CONC-OR', 'L', 11800, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 150 }),
    await make('Beverage Concentrate — Citrus', 'RM-CONC-CT', 'L', 13900, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 150 }),
    await make('Citric Acid', 'RM-CITRIC', 'kg', 2400, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 300 }),
    await make('Sodium Benzoate', 'RM-BENZ', 'kg', 3100, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 150 }),
    await make('Carbon Dioxide (CO2)', 'RM-CO2', 'kg', 1450, 'RAW_MATERIAL', rawCat.id, { ...rawOpts, safetyStock: 500 }),
    await make('Treated Water', 'RM-WATER', 'L', 12, 'RAW_MATERIAL', rawCat.id, { sellable: false, purchaseEnabled: false }),
  ];

  const pkgOpts = { sellable: false, purchaseEnabled: true, batchTracked: true };
  const packaging = [
    await make('PET Bottle 50cl', 'PK-PET50', 'each', 28, 'PACKAGING', pkgCat.id, { ...pkgOpts, safetyStock: 100000 }),
    await make('Bottle Cap', 'PK-CAP', 'each', 6, 'PACKAGING', pkgCat.id, { ...pkgOpts, safetyStock: 100000 }),
    await make('Label — Lemon Lime', 'PK-LBL-LL', 'each', 4, 'PACKAGING', pkgCat.id, pkgOpts),
    await make('Label — Cola', 'PK-LBL-CO', 'each', 4, 'PACKAGING', pkgCat.id, pkgOpts),
    await make('Label — Orange', 'PK-LBL-OR', 'each', 4, 'PACKAGING', pkgCat.id, pkgOpts),
    await make('Label — Citrus', 'PK-LBL-CT', 'each', 4, 'PACKAGING', pkgCat.id, pkgOpts),
    await make('Shrink Film', 'PK-FILM', 'kg', 1900, 'PACKAGING', pkgCat.id, pkgOpts),
    await make('Carton — 12 bottle', 'PK-CTN12', 'each', 210, 'PACKAGING', pkgCat.id, pkgOpts),
  ];

  const fgOpts = { manufacturingEnabled: true, purchaseEnabled: false, batchTracked: true, expiryTracked: true };
  const finished = [
    await make('7UP 50cl (Demo)', 'FG-7UP50', 'case', 2900, 'FINISHED_GOOD', fgCat.id, fgOpts),
    await make('Pepsi 50cl (Demo)', 'FG-PEP50', 'case', 2950, 'FINISHED_GOOD', fgCat.id, fgOpts),
    await make('Mirinda 50cl (Demo)', 'FG-MIR50', 'case', 2880, 'FINISHED_GOOD', fgCat.id, fgOpts),
    await make('Mountain Dew 50cl (Demo)', 'FG-MTD50', 'case', 3050, 'FINISHED_GOOD', fgCat.id, fgOpts),
    await make('Aquafina 50cl (Demo)', 'FG-AQU50', 'case', 1450, 'FINISHED_GOOD', fgCat.id, fgOpts),
  ];

  const spares = [
    await make('Filler Seal Kit', 'SP-SEAL', 'each', 45000, 'SPARE_PART', spareCat.id, { sellable: false }),
    await make('Conveyor Belt 2m', 'SP-BELT', 'each', 78000, 'SPARE_PART', spareCat.id, { sellable: false }),
    await make('Capper Head', 'SP-CAPHD', 'each', 132000, 'SPARE_PART', spareCat.id, { sellable: false }),
  ];

  return { materials, packaging, finished, spares };
}

async function seedSuppliers(products: SeededProduct[]) {
  const specs: { name: string; terms: string; lead: number; supplies: string[] }[] = [
    { name: 'Prime Sugar Industries Ltd', terms: '30 days', lead: 7, supplies: ['Refined Sugar'] },
    {
      name: 'Nigerian Beverage Ingredients Ltd', terms: '45 days', lead: 21,
      supplies: products.filter((p) => p.name.startsWith('Beverage Concentrate')).map((p) => p.name),
    },
    { name: 'West Africa Chemical Supplies Ltd', terms: '30 days', lead: 14, supplies: ['Citric Acid', 'Sodium Benzoate'] },
    {
      name: 'Lagos Packaging Solutions Ltd', terms: '14 days', lead: 5,
      supplies: products.filter((p) => p.name.startsWith('PET') || p.name.startsWith('Bottle') || p.name.startsWith('Label') || p.name.startsWith('Carton') || p.name.startsWith('Shrink')).map((p) => p.name),
    },
    { name: 'National Industrial Gases Ltd', terms: 'On delivery', lead: 3, supplies: ['Carbon Dioxide (CO2)'] },
  ];

  const created = [];
  for (const spec of specs) {
    const supplier = await db.supplier.create({
      data: {
        organizationId: orgId,
        name: spec.name,
        contactName: 'Sales Desk',
        email: `sales@${slugify(spec.name)}.example`,
        phone: '+234800000000',
        city: 'Lagos',
        country: 'NG',
        currency: 'NGN',
        paymentTerms: spec.terms,
        leadTimeDays: spec.lead,
        isActive: true,
      },
    });
    for (const name of spec.supplies) {
      const product = products.find((p) => p.name === name);
      if (!product) continue;
      await db.supplierProduct.create({
        data: {
          organizationId: orgId,
          supplierId: supplier.id,
          productId: product.productId,
          supplierSku: `${supplier.name.slice(0, 3).toUpperCase()}-${product.name.slice(0, 6).toUpperCase()}`,
          costPrice: product.cost,
          currency: 'NGN',
          leadTimeDays: spec.lead,
          minOrderQty: 100,
          isPreferred: true,
        },
      });
    }
    created.push(supplier);
  }
  return created;
}

async function seedLines() {
  const specs = [
    { name: 'Production Line 1', code: 'PL-1', capacity: 12000, unit: 'cases/day', status: 'OPERATIONAL' },
    { name: 'Production Line 2', code: 'PL-2', capacity: 9000, unit: 'cases/day', status: 'OPERATIONAL' },
    { name: 'Water Production Line', code: 'PL-WTR', capacity: 20000, unit: 'cases/day', status: 'IDLE' },
    { name: 'Energy Drink Line', code: 'PL-NRG', capacity: 6000, unit: 'cases/day', status: 'MAINTENANCE' },
  ];
  return Promise.all(
    specs.map((s) =>
      db.productionLine.create({
        data: {
          organizationId: orgId, name: s.name, code: s.code,
          capacity: s.capacity, capacityUnit: s.unit,
          status: s.status as never, location: 'Lagos Plant',
        },
      }),
    ),
  );
}

async function seedEquipment(lines: { id: string; code: string }[]) {
  const line = (code: string) => lines.find((l) => l.code === code)?.id ?? null;
  const specs = [
    { name: 'Bottle Filler A', code: 'EQ-FIL-A', line: 'PL-1', freq: 90, last: -100, status: 'OPERATIONAL' },
    { name: 'Capper A', code: 'EQ-CAP-A', line: 'PL-1', freq: 120, last: -30, status: 'OPERATIONAL' },
    { name: 'Labeller A', code: 'EQ-LBL-A', line: 'PL-1', freq: 60, last: -20, status: 'OPERATIONAL' },
    { name: 'Bottle Filler B', code: 'EQ-FIL-B', line: 'PL-2', freq: 90, last: -80, status: 'OPERATIONAL' },
    { name: 'Water Treatment Unit', code: 'EQ-WTR', line: 'PL-WTR', freq: 30, last: -45, status: 'OPERATIONAL' },
    { name: 'Carbonator', code: 'EQ-CARB', line: 'PL-NRG', freq: 90, last: -10, status: 'BREAKDOWN' },
  ];
  return Promise.all(
    specs.map((s) =>
      db.equipment.create({
        data: {
          organizationId: orgId, name: s.name, code: s.code,
          category: 'Process equipment',
          productionLineId: line(s.line),
          manufacturer: 'Demo Machinery Co',
          model: `DM-${s.code}`,
          serialNumber: `SN-${s.code}-0001`,
          purchaseDate: day(-900),
          status: s.status as never,
          maintenanceFrequencyDays: s.freq,
          lastMaintenanceAt: day(s.last),
          // Deliberately in the past for some, so the "due" list is not empty.
          nextMaintenanceAt: day(s.last + s.freq),
          location: 'Lagos Plant',
        },
      }),
    ),
  );
}

async function seedMaintenance(
  equipment: { id: string; name: string }[],
  spares: SeededProduct[],
  storeId: string,
) {
  const filler = equipment[0]!;
  const carbonator = equipment[5]!;

  // Completed, with a part fitted and downtime recorded.
  const completed = await db.maintenanceWorkOrder.create({
    data: {
      organizationId: orgId, workOrderNumber: 'WO-00001', equipmentId: filler.id,
      type: 'PREVENTIVE', issue: 'Scheduled 90-day service', priority: 'MEDIUM',
      status: 'COMPLETED', startDate: day(-12), completionDate: day(-12),
      downtimeMinutes: 180, cost: 45000 + 20000,
      notes: 'Seals replaced, filler recalibrated.',
    },
  });
  await db.maintenancePart.create({
    data: {
      organizationId: orgId, workOrderId: completed.id,
      variantId: spares[0]!.variantId, warehouseId: storeId,
      quantity: 1, unitCost: spares[0]!.cost, issuedAt: day(-12),
    },
  });

  // Scheduled, not started.
  await db.maintenanceWorkOrder.create({
    data: {
      organizationId: orgId, workOrderNumber: 'WO-00002', equipmentId: equipment[3]!.id,
      type: 'PREVENTIVE', issue: 'Scheduled service due', priority: 'LOW',
      status: 'ASSIGNED', startDate: day(3),
    },
  });

  // A breakdown, still open — which is why its line reads MAINTENANCE.
  await db.maintenanceWorkOrder.create({
    data: {
      organizationId: orgId, workOrderNumber: 'WO-00003', equipmentId: carbonator.id,
      type: 'EMERGENCY', issue: 'Carbonator pressure loss — line stopped', priority: 'EMERGENCY',
      status: 'IN_PROGRESS', startDate: day(-1),
    },
  });
}

async function seedOpeningStock(
  materials: SeededProduct[],
  packaging: SeededProduct[],
  spares: SeededProduct[],
  warehouses: Record<string, { id: string }>,
) {
  const book = async (p: SeededProduct, warehouseId: string, quantity: number) => {
    await db.stockLevel.create({
      data: { organizationId: orgId, warehouseId, variantId: p.variantId, quantity },
    });
    await db.stockMovement.create({
      data: {
        organizationId: orgId, warehouseId, variantId: p.variantId,
        type: 'ADJUSTMENT', quantity, referenceType: 'OPENING_BALANCE',
        reason: 'Opening balance (demo data)', actorUserId: userId, createdAt: day(-60),
      },
    });
  };

  const opening: Record<string, number> = {
    'Refined Sugar': 8000,          // below its 10,000 floor, so shortages are real
    'Beverage Concentrate — Lemon Lime': 900,
    'Beverage Concentrate — Cola': 1100,
    'Beverage Concentrate — Orange': 700,
    'Beverage Concentrate — Citrus': 400,
    'Citric Acid': 1200,
    'Sodium Benzoate': 600,
    'Carbon Dioxide (CO2)': 2200,
    'Treated Water': 500000,
  };
  for (const material of materials) {
    await book(material, warehouses.rawMaterials.id, opening[material.name] ?? 1000);
  }
  for (const pack of packaging) {
    await book(pack, warehouses.packaging.id, pack.unit === 'each' ? 400000 : 800);
  }
  for (const spare of spares) {
    await book(spare, warehouses.maintenance.id, 4);
  }
}

async function seedBoms(
  finished: SeededProduct[],
  materials: SeededProduct[],
  packaging: SeededProduct[],
  warehouseId: string,
) {
  const m = (name: string) => materials.find((x) => x.name === name)!;
  const p = (name: string) => packaging.find((x) => x.name === name)!;

  /*
   * Per 1,000 cases of twelve 50cl bottles. Illustrative round numbers chosen
   * to make the arithmetic easy to follow on screen — not anybody's recipe.
   */
  const recipes: { product: string; concentrate: string; label: string; sugar: number }[] = [
    { product: '7UP 50cl (Demo)', concentrate: 'Beverage Concentrate — Lemon Lime', label: 'Label — Lemon Lime', sugar: 650 },
    { product: 'Pepsi 50cl (Demo)', concentrate: 'Beverage Concentrate — Cola', label: 'Label — Cola', sugar: 700 },
    { product: 'Mirinda 50cl (Demo)', concentrate: 'Beverage Concentrate — Orange', label: 'Label — Orange', sugar: 720 },
    { product: 'Mountain Dew 50cl (Demo)', concentrate: 'Beverage Concentrate — Citrus', label: 'Label — Citrus', sugar: 690 },
  ];

  const created = [];
  let n = 1;
  for (const recipe of recipes) {
    const product = finished.find((f) => f.name === recipe.product)!;
    const bom = await db.billOfMaterial.create({
      data: {
        organizationId: orgId,
        bomNumber: `BOM-${String(n++).padStart(5, '0')}`,
        productId: product.productId,
        version: 1,
        status: 'ACTIVE',
        effectiveFrom: day(-120),
        outputQuantity: 1000,
        warehouseId,
        notes: 'Illustrative demonstration recipe — not an actual formulation.',
        items: {
          create: [
            { organizationId: orgId, variantId: m('Refined Sugar').variantId, quantity: recipe.sugar, unit: 'kg', scrapPercent: 1 },
            { organizationId: orgId, variantId: m(recipe.concentrate).variantId, quantity: 100, unit: 'L', scrapPercent: 0.5 },
            { organizationId: orgId, variantId: m('Citric Acid').variantId, quantity: 8, unit: 'kg' },
            { organizationId: orgId, variantId: m('Sodium Benzoate').variantId, quantity: 3, unit: 'kg' },
            { organizationId: orgId, variantId: m('Carbon Dioxide (CO2)').variantId, quantity: 45, unit: 'kg' },
            { organizationId: orgId, variantId: m('Treated Water').variantId, quantity: 5400, unit: 'L' },
            { organizationId: orgId, variantId: p('PET Bottle 50cl').variantId, quantity: 12000, unit: 'each', scrapPercent: 2 },
            { organizationId: orgId, variantId: p('Bottle Cap').variantId, quantity: 12000, unit: 'each', scrapPercent: 2 },
            { organizationId: orgId, variantId: p(recipe.label).variantId, quantity: 12000, unit: 'each', scrapPercent: 3 },
            { organizationId: orgId, variantId: p('Carton — 12 bottle').variantId, quantity: 1000, unit: 'each', scrapPercent: 1 },
          ],
        },
      },
    });
    created.push(bom);
  }

  // Water needs no sugar or concentrate — a deliberately different shape.
  const water = finished.find((f) => f.name === 'Aquafina 50cl (Demo)')!;
  created.push(
    await db.billOfMaterial.create({
      data: {
        organizationId: orgId,
        bomNumber: `BOM-${String(n++).padStart(5, '0')}`,
        productId: water.productId,
        version: 1, status: 'ACTIVE', effectiveFrom: day(-120),
        outputQuantity: 1000, warehouseId,
        notes: 'Illustrative demonstration recipe — not an actual formulation.',
        items: {
          create: [
            { organizationId: orgId, variantId: m('Treated Water').variantId, quantity: 6000, unit: 'L' },
            { organizationId: orgId, variantId: p('PET Bottle 50cl').variantId, quantity: 12000, unit: 'each', scrapPercent: 2 },
            { organizationId: orgId, variantId: p('Bottle Cap').variantId, quantity: 12000, unit: 'each', scrapPercent: 2 },
            { organizationId: orgId, variantId: p('Carton — 12 bottle').variantId, quantity: 1000, unit: 'each', scrapPercent: 1 },
          ],
        },
      },
    }),
  );
  return created;
}

async function seedPurchaseOrders(
  suppliers: { id: string; name: string }[],
  materials: SeededProduct[],
  packaging: SeededProduct[],
  warehouseId: string,
) {
  const sugarSupplier = suppliers.find((s) => s.name.startsWith('Prime Sugar'))!;
  const packSupplier = suppliers.find((s) => s.name.startsWith('Lagos Packaging'))!;
  const chemSupplier = suppliers.find((s) => s.name.startsWith('West Africa'))!;
  const sugar = materials.find((m) => m.name === 'Refined Sugar')!;
  const bottles = packaging.find((p) => p.name === 'PET Bottle 50cl')!;
  const citric = materials.find((m) => m.name === 'Citric Acid')!;

  const order = async (
    number: string, supplierId: string, item: SeededProduct,
    quantity: number, receivedQty: number, status: string, expectedAt: Date,
  ) => {
    const total = quantity * item.cost;
    const po = await db.purchaseOrder.create({
      data: {
        organizationId: orgId, number, supplierId, warehouseId,
        status: status as never, currency: 'NGN',
        subtotal: total, taxTotal: 0, total,
        expectedAt, createdAt: day(-20),
        items: {
          // Purchase order lines hang off the order and carry no
          // organizationId of their own.
          create: [{
            variantId: item.variantId,
            quantity, receivedQty, unitCost: item.cost, taxRate: 0, total,
          }],
        },
      },
    });
    return po;
  };

  // Four states a buyer actually sees.
  const receivedPo = await order('PO-00001', sugarSupplier.id, sugar, 20000, 20000, 'RECEIVED', day(-10));

  /*
   * The delivery, with the supplier's own lot number on it.
   *
   * This is the link that makes a recall possible: the finished batch knows
   * the run, the run knows the lot it consumed, and the lot is only traceable
   * to a supplier because it was written down on the way in.
   */
  const poItem = await db.purchaseOrderItem.findFirstOrThrow({
    where: { purchaseOrderId: receivedPo.id },
  });
  const receipt = await db.purchaseOrderReceipt.create({
    data: {
      organizationId: orgId, purchaseOrderId: receivedPo.id,
      warehouseId, receivedById: userId, createdAt: day(-10),
    },
  });
  await db.purchaseOrderReceiptLine.create({
    data: {
      // Receipt lines hang off the receipt; no org id of their own.
      receiptId: receipt.id, itemId: poItem.id,
      variantId: sugar.variantId,
      quantity: 20000, batchNumber: SUGAR_LOT,
      // The whole order was outstanding when this delivery arrived.
      outstandingAtReceipt: 20000,
      expiryDate: day(540),
    },
  });
  await order('PO-00002', packSupplier.id, bottles, 500000, 200000, 'PARTIALLY_RECEIVED', day(-2));
  await order('PO-00003', chemSupplier.id, citric, 2000, 0, 'ORDERED', day(9));
  // Past its promised date and still not here — this is what "overdue" means.
  await order('PO-00004', sugarSupplier.id, sugar, 15000, 0, 'ORDERED', day(-5));
}

async function seedWorkflow(input: {
  finished: SeededProduct[];
  materials: SeededProduct[];
  boms: { id: string; productId: string; bomNumber: string }[];
  lines: { id: string; code: string }[];
  warehouses: Record<string, { id: string }>;
}) {
  const { finished, materials, boms, lines, warehouses } = input;
  const sevenUp = finished[0]!;
  const pepsi = finished[1]!;
  const mirinda = finished[2]!;
  const water = finished[4]!;
  const line1 = lines[0]!.id;
  const sugar = materials.find((m) => m.name === 'Refined Sugar')!;

  const bomFor = (p: SeededProduct) => boms.find((b) => b.productId === p.productId)!;

  // ── A plan, approved, that became an order ───────────────────────────────
  const plan = await db.productionPlan.create({
    data: {
      organizationId: orgId, planNumber: 'PLAN-00001',
      productId: sevenUp.productId, bomId: bomFor(sevenUp).id,
      quantity: 10000, productionDate: day(-14),
      expectedCompletionDate: day(-13), productionLineId: line1,
      warehouseId: warehouses.rawMaterials.id,
      priority: 'HIGH', status: 'IN_PROGRESS',
      notes: 'Monthly volume for the Lagos depot.',
    },
  });

  // ── Completed run, with a passed batch ───────────────────────────────────
  const completed = await createRun({
    number: 'PROD-00001', product: sevenUp, bom: bomFor(sevenUp), planId: plan.id,
    line: line1, warehouses, planned: 10000, produced: 9800, rejected: 200,
    status: 'COMPLETED', start: day(-14), finish: day(-13), sugarVariantId: sugar.variantId,
  });
  await createBatchFor(completed, sevenUp, warehouses.finishedLagos.id, 9600, 'PASSED', day(-13));

  // ── Completed run whose batch failed and is held ─────────────────────────
  const failedRun = await createRun({
    number: 'PROD-00002', product: pepsi, bom: bomFor(pepsi), planId: null,
    line: line1, warehouses, planned: 5000, produced: 5000, rejected: 0,
    status: 'COMPLETED', start: day(-7), finish: day(-6), sugarVariantId: sugar.variantId,
  });
  const heldBatch = await createBatchFor(
    failedRun, pepsi, warehouses.quarantine.id, 5000, 'FAILED', day(-6),
  );
  await db.batch.update({ where: { id: heldBatch.id }, data: { isQuarantined: true } });
  await db.quarantineRecord.create({
    data: {
      organizationId: orgId, batchId: heldBatch.id, quantity: 5000,
      reason: 'Carbonation below specification on the second inspection',
      status: 'HELD', heldByUserId: userId, heldAt: day(-6),
    },
  });

  // ── A run under way ──────────────────────────────────────────────────────
  const running = await createRun({
    number: 'PROD-00003', product: mirinda, bom: bomFor(mirinda), planId: null,
    line: lines[1]!.id, warehouses, planned: 8000, produced: 0, rejected: 0,
    status: 'IN_PROGRESS', start: day(-1), finish: null, sugarVariantId: sugar.variantId,
  });
  // Material issued but not yet all consumed — mid-run, as it really looks.
  const sugarMaterial = await db.productionMaterial.findFirst({
    where: { productionOrderId: running.id, variantId: sugar.variantId },
  });
  if (sugarMaterial) {
    await db.productionMaterial.update({
      where: { id: sugarMaterial.id },
      data: { issuedQuantity: 5000, consumedQuantity: 4200 },
    });
    await db.materialConsumption.create({
      data: {
        organizationId: orgId, productionOrderId: running.id,
        warehouseId: warehouses.rawMaterials.id, variantId: sugar.variantId,
        requiredQuantity: sugarMaterial.requiredQuantity,
        issuedQuantity: 5000, consumedQuantity: 4200,
        issuedByUserId: userId, occurredAt: day(-1),
      },
    });
  }

  // ── A planned run, and a cancelled one ───────────────────────────────────
  await createRun({
    number: 'PROD-00004', product: water, bom: bomFor(water), planId: null,
    line: lines[2]!.id, warehouses, planned: 15000, produced: 0, rejected: 0,
    status: 'APPROVED', start: day(2), finish: null, sugarVariantId: sugar.variantId,
  });
  await createRun({
    number: 'PROD-00005', product: pepsi, bom: bomFor(pepsi), planId: null,
    line: line1, warehouses, planned: 4000, produced: 0, rejected: 0,
    status: 'CANCELLED', start: day(-3), finish: null, sugarVariantId: sugar.variantId,
  });

  // ── Internal requisitions in four states ─────────────────────────────────
  const requisition = async (
    number: string, status: string, requested: number, approved: number, issued: number,
  ) =>
    db.internalRequisition.create({
      data: {
        organizationId: orgId, number,
        fromWarehouseId: warehouses.packaging.id,
        toWarehouseId: warehouses.rawMaterials.id,
        status: status as never, priority: 'NORMAL',
        reason: 'Materials for the current production schedule',
        requestedById: userId, createdAt: day(-4),
        items: {
          // Requisition lines belong to the requisition; no org id of their own.
          create: [{
            variantId: sugar.variantId,
            requestedQty: requested, approvedQty: approved, dispatchedQty: issued, receivedQty: issued,
          }],
        },
      },
    });

  await requisition('IR-00001', 'SUBMITTED', 3000, 0, 0);
  await requisition('IR-00002', 'APPROVED', 2500, 2500, 0);
  await requisition('IR-00003', 'PARTIALLY_DISPATCHED', 4000, 4000, 1500);
  await requisition('IR-00004', 'COMPLETED', 1000, 1000, 1000);
}

async function createRun(input: {
  number: string;
  product: SeededProduct;
  bom: { id: string };
  planId: string | null;
  line: string;
  warehouses: Record<string, { id: string }>;
  planned: number;
  produced: number;
  rejected: number;
  status: string;
  start: Date;
  finish: Date | null;
  /** So the sugar line can be stamped with the lot it came from. */
  sugarVariantId: string;
}) {
  const items = await db.billOfMaterialItem.findMany({
    where: { bomId: input.bom.id },
    select: { variantId: true, quantity: true, unit: true, scrapPercent: true },
  });
  const bom = await db.billOfMaterial.findUniqueOrThrow({
    where: { id: input.bom.id },
    select: { outputQuantity: true },
  });
  const multiplier = input.planned / Number(bom.outputQuantity);

  const order = await db.productionOrder.create({
    data: {
      organizationId: orgId, orderNumber: input.number,
      planId: input.planId, productId: input.product.productId, bomId: input.bom.id,
      plannedQuantity: input.planned,
      actualQuantity: input.produced - input.rejected,
      rejectedQuantity: input.rejected,
      productionLineId: input.line,
      warehouseId: input.warehouses.rawMaterials.id,
      finishedWarehouseId: input.warehouses.finishedLagos.id,
      startDate: input.start,
      expectedCompletionDate: input.finish ?? new Date(input.start.getTime() + 86_400_000),
      actualCompletionDate: input.finish,
      status: input.status as never,
      priority: 'NORMAL',
      materials: {
        create: items.map((item) => {
          const base = Number(item.quantity) * multiplier;
          const required = base + base * (Number(item.scrapPercent) / 100);
          const done = input.status === 'COMPLETED';
          return {
            organizationId: orgId,
            variantId: item.variantId,
            requiredQuantity: Math.round(required * 1000) / 1000,
            // A completed run consumed slightly more than the recipe said —
            // which is what makes the variance figures non-zero and worth
            // looking at.
            issuedQuantity: done ? Math.round(required * 1.02 * 1000) / 1000 : 0,
            consumedQuantity: done ? Math.round(required * 1.015 * 1000) / 1000 : 0,
            unit: item.unit,
          };
        }),
      },
    },
  });

  /*
   * A completed run leaves consumption records behind, not just totals.
   *
   * Without these the trace stops at the production order — it knows what it
   * was *supposed* to use but not what actually went in, which is exactly the
   * question a recall asks.
   */
  if (input.status === 'COMPLETED') {
    const materials = await db.productionMaterial.findMany({
      where: { productionOrderId: order.id },
      select: { variantId: true, requiredQuantity: true, issuedQuantity: true, consumedQuantity: true },
    });
    for (const material of materials) {
      await db.materialConsumption.create({
        data: {
          organizationId: orgId,
          productionOrderId: order.id,
          warehouseId: input.warehouses.rawMaterials.id,
          variantId: material.variantId,
          requiredQuantity: material.requiredQuantity,
          issuedQuantity: material.issuedQuantity,
          consumedQuantity: material.consumedQuantity,
          // Only the sugar carries a lot here, so the demo shows both a
          // traceable material and the honest gap where one is missing.
          batchNumber: material.variantId === input.sugarVariantId ? SUGAR_LOT : null,
          issuedByUserId: userId,
          occurredAt: input.finish ?? input.start,
        },
      });
    }
  }

  return order;
}

async function createBatchFor(
  order: { id: string },
  product: SeededProduct,
  warehouseId: string,
  good: number,
  qcStatus: string,
  producedAt: Date,
) {
  const batchNumber = `${product.name.split(' ')[0]!.toUpperCase()}-${producedAt
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')}-001`;

  const batch = await db.batch.create({
    data: {
      organizationId: orgId, batchNumber, variantId: product.variantId,
      productionOrderId: order.id, productionDate: producedAt,
      expiryDate: new Date(producedAt.getTime() + 180 * 86_400_000),
      quantityProduced: good, quantityAvailable: good,
      warehouseId, qcStatus: qcStatus as never,
    },
  });

  await db.productionOutput.create({
    data: {
      organizationId: orgId, productionOrderId: order.id, variantId: product.variantId,
      plannedQuantity: good, producedQuantity: good, rejectedQuantity: 0,
      goodQuantity: good, warehouseId, batchId: batch.id,
      productionDate: producedAt, recordedByUserId: userId,
    },
  });

  // Passed stock is on the shelf and sellable; failed stock is held.
  const held = qcStatus !== 'PASSED';
  await db.stockLevel.create({
    data: {
      organizationId: orgId, warehouseId, variantId: product.variantId,
      quantity: good, reserved: held ? good : 0,
    },
  });
  await db.stockMovement.create({
    data: {
      organizationId: orgId, warehouseId, variantId: product.variantId,
      type: 'PRODUCTION', quantity: good,
      referenceType: 'PRODUCTION_ORDER', referenceId: order.id,
      batchNumber, actorUserId: userId, createdAt: producedAt,
    },
  });

  await db.qualityInspection.create({
    data: {
      organizationId: orgId,
      inspectionNumber: `QC-${batchNumber}`,
      variantId: product.variantId, batchId: batch.id, productionOrderId: order.id,
      inspectorUserId: userId, inspectedAt: producedAt,
      status: qcStatus as never,
      comments: qcStatus === 'PASSED' ? 'Within specification.' : 'Carbonation below specification.',
      items: {
        create: [
          {
            organizationId: orgId, name: 'pH', unit: 'pH',
            expectedMin: 3.2, expectedMax: 3.8,
            actualNumeric: qcStatus === 'PASSED' ? 3.5 : 4.4,
            actualValue: qcStatus === 'PASSED' ? '3.5' : '4.4',
            passed: qcStatus === 'PASSED',
          },
          {
            organizationId: orgId, name: 'Packaging integrity',
            expectedText: 'Intact', actualValue: 'Intact', passed: true,
          },
        ],
      },
    },
  });
  return batch;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function wipe() {
  const org = await db.organization.findFirst({ where: { slug: SLUG }, select: { id: true } });
  if (!org) return;
  const id = org.id;
  console.log(`Removing the existing "${SLUG}" demo…`);
  // Children first — the demo owns everything under it.
  for (const remove of [
    () => db.qualityInspectionItem.deleteMany({ where: { organizationId: id } }),
    () => db.qualityInspection.deleteMany({ where: { organizationId: id } }),
    () => db.quarantineRecord.deleteMany({ where: { organizationId: id } }),
    () => db.productionOutput.deleteMany({ where: { organizationId: id } }),
    () => db.materialConsumption.deleteMany({ where: { organizationId: id } }),
    () => db.batch.deleteMany({ where: { organizationId: id } }),
    () => db.productionMaterial.deleteMany({ where: { organizationId: id } }),
    () => db.productionVariance.deleteMany({ where: { organizationId: id } }),
    () => db.productionCost.deleteMany({ where: { organizationId: id } }),
    () => db.productionOrder.deleteMany({ where: { organizationId: id } }),
    () => db.productionPlan.deleteMany({ where: { organizationId: id } }),
    () => db.billOfMaterialItem.deleteMany({ where: { organizationId: id } }),
    () => db.billOfMaterial.deleteMany({ where: { organizationId: id } }),
    () => db.maintenancePart.deleteMany({ where: { organizationId: id } }),
    () => db.maintenanceWorkOrder.deleteMany({ where: { organizationId: id } }),
    () => db.equipment.deleteMany({ where: { organizationId: id } }),
    () => db.productionLine.deleteMany({ where: { organizationId: id } }),
    () => db.internalRequisitionItem.deleteMany({ where: { requisition: { organizationId: id } } }),
    () => db.internalRequisition.deleteMany({ where: { organizationId: id } }),
    () => db.purchaseOrderReceiptLine.deleteMany({ where: { receipt: { organizationId: id } } }),
    () => db.purchaseOrderReceipt.deleteMany({ where: { organizationId: id } }),
    () => db.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { organizationId: id } } }),
    () => db.purchaseOrder.deleteMany({ where: { organizationId: id } }),
    () => db.supplierProduct.deleteMany({ where: { organizationId: id } }),
    () => db.supplier.deleteMany({ where: { organizationId: id } }),
    () => db.stockMovement.deleteMany({ where: { organizationId: id } }),
    () => db.stockLevel.deleteMany({ where: { organizationId: id } }),
    () => db.productVariant.deleteMany({ where: { organizationId: id } }),
    () => db.product.deleteMany({ where: { organizationId: id } }),
    () => db.productCategory.deleteMany({ where: { organizationId: id } }),
    () => db.warehouse.deleteMany({ where: { organizationId: id } }),
    () => db.manufacturingSettings.deleteMany({ where: { organizationId: id } }),
    () => db.notification.deleteMany({ where: { organizationId: id } }),
    () => db.auditLog.deleteMany({ where: { organizationId: id } }),
    () => db.rolePermission.deleteMany({ where: { role: { organizationId: id } } }),
    () => db.membership.deleteMany({ where: { organizationId: id } }),
    () => db.role.deleteMany({ where: { organizationId: id } }),
    () => db.organizationModule.deleteMany({ where: { organizationId: id } }),
  ]) {
    await remove().catch(() => undefined);
  }
  // Signing in as the demo user leaves refresh tokens and notifications behind,
  // and both hold the user row down with a RESTRICT foreign key — so --remove
  // used to leave an orphaned account behind after any hands-on session.
  const demoEmail = `demo+${SLUG}@vhicasar.test`;
  const demoUser = await db.user.findUnique({ where: { email: demoEmail }, select: { id: true } });
  if (demoUser) {
    await db.refreshToken.deleteMany({ where: { userId: demoUser.id } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { userId: demoUser.id } }).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { email: demoEmail } }).catch(() => undefined);
  await db.organization.delete({ where: { id } }).catch(() => undefined);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
