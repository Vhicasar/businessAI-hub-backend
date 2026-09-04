/*
 * Manufacturing & Operations.
 *
 * Grows a stage at a time. The first thing it has to prove is the promise in
 * §35: a business that does not make anything must be completely unaffected by
 * all of this. Every manufacturing column is optional or defaulted to what the
 * product already did, so the rows that existed yesterday behave identically
 * today.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { catalogService } from '../../src/application/catalog/catalog.service';
import { inventoryService } from '../../src/application/inventory/inventory.service';
import { hasModule } from '../../src/application/modules/business-modules';
import { bomService } from '../../src/application/manufacturing/bom.service';
import { productionOrdersService } from '../../src/application/manufacturing/production-orders.service';
import { materialConsumptionService } from '../../src/application/manufacturing/material-consumption.service';
import { productionOutputService } from '../../src/application/manufacturing/production-output.service';
import { batchesService } from '../../src/application/manufacturing/batches.service';
import { productionPlanningService } from '../../src/application/manufacturing/production-planning.service';
import { procurementRecommendationsService } from '../../src/application/manufacturing/procurement-recommendations.service';
import { qualityControlService } from '../../src/application/manufacturing/quality-control.service';
import {
  quarantineDecisionSchema,
  quarantineService,
} from '../../src/application/manufacturing/quarantine.service';
import { productionLinesService } from '../../src/application/manufacturing/production-lines.service';
import { equipmentService } from '../../src/application/manufacturing/equipment.service';
import { costingService } from '../../src/application/manufacturing/costing.service';
import { manufacturingDashboard } from '../../src/application/manufacturing/dashboard.service';
import { manufacturingAnalytics } from '../../src/application/manufacturing/analytics.service';
import { manufacturingAi } from '../../src/application/manufacturing/manufacturing-ai.service';
import { manufacturingAlerts } from '../../src/application/manufacturing/manufacturing-alerts.service';
import { manufacturingSettings } from '../../src/application/manufacturing/settings.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let shopId = '', factoryId = '', userId = '';
/**
 * Owner membership per organisation.
 *
 * Services now check permissions themselves where one endpoint covers several
 * jobs (approving and cancelling a run are not the same permission), so the
 * context a test runs under has to look like a real signed-in session rather
 * than an org id on its own.
 */
const memberships = new Map<string, string>();
const as = <T>(orgId: string, fn: () => Promise<T>): Promise<T> =>
  requestContext.run(
    { organizationId: orgId, userId, membershipId: memberships.get(orgId) } as never,
    fn,
  );

/** The owner every real business has, so permission checks have someone to ask about. */
async function makeOwner(orgId: string): Promise<void> {
  const role = await db.role.create({
    data: { organizationId: orgId, name: `Owner-${stamp}`, isSystem: false },
  });
  const membership = await db.membership.create({
    data: { organizationId: orgId, userId, roleId: role.id, isOwner: true, isActive: true },
  });
  memberships.set(orgId, membership.id);
}

async function main() {
  userId = (await db.user.create({
    data: { email: `mfg-${stamp}@t.test`, passwordHash: 'x', firstName: 'Mo', lastName: 'A' },
  })).id;
  shopId = (await db.organization.create({
    data: { name: 'Corner Shop', slug: `shop-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG', businessType: 'RETAIL' },
  })).id;
  factoryId = (await db.organization.create({
    data: { name: 'Bottling Co', slug: `fact-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG', businessType: 'MANUFACTURING' },
  })).id;
  await makeOwner(shopId);
  await makeOwner(factoryId);

  console.log('\n=== 1. A SHOP IS UNTOUCHED BY ANY OF THIS ===');
  {
    check('and does not have the module', !(await hasModule(shopId, 'manufacturing')));

    // Created exactly as the catalogue has always created products.
    const product = await as(shopId, () =>
      catalogService.createProduct({
        name: 'Tin of beans',
        status: 'ACTIVE',
        taxRate: 0,
        variants: [{ sku: `BEANS-${stamp}`, price: 1200, isDefault: true }],
      } as never),
    );
    const row = await db.product.findUniqueOrThrow({ where: { id: product.id } });

    // The defaults have to describe what the product already was, or every
    // existing row quietly changes meaning.
    check('it is sellable, as every product always has been', row.sellable === true);
    check('and purchasable', row.purchaseEnabled === true);
    check('it is not something the shop manufactures', row.manufacturingEnabled === false);
    check('and carries no manufacturing classification', row.manufacturingType === null);
    check('no batch tracking is imposed on it', row.batchTracked === false);
    check('nor expiry tracking', row.expiryTracked === false);
    check('and no stock planning levels are invented', row.minStock === null && row.safetyStock === null);
  }

  console.log('\n=== 2. EXISTING WAREHOUSES ARE JUST WAREHOUSES ===');
  {
    const wh = await as(shopId, () =>
      inventoryService.createWarehouse({ name: 'Back room', code: `BR${stamp}`.slice(0, 20) } as never),
    );
    const row = await db.warehouse.findUniqueOrThrow({ where: { id: wh.id } });
    // GENERAL is what every warehouse in the product already is; classifying
    // them is something a manufacturer opts into.
    check('a new warehouse is GENERAL', row.warehouseType === 'GENERAL');

    const listed = await as(shopId, () => inventoryService.listWarehouses());
    check('and still lists as it always did', listed.some((w) => w.id === wh.id));
  }

  console.log('\n=== 3. A MANUFACTURER CAN SAY WHAT ITS PRODUCTS ARE ===');
  {
    check('the factory has the module', await hasModule(factoryId, 'manufacturing'));

    const sugar = await as(factoryId, () =>
      catalogService.createProduct({
        name: 'Refined sugar',
        status: 'ACTIVE',
        taxRate: 0,
        unit: 'kg',
        variants: [{ sku: `SUGAR-${stamp}`, price: 0, costPrice: 850, isDefault: true }],
      } as never),
    );
    // Classification is applied through the same product the rest of the
    // system already knows about — not a parallel "material" record.
    await db.product.update({
      where: { id: sugar.id },
      data: {
        manufacturingType: 'RAW_MATERIAL',
        purchaseEnabled: true,
        sellable: false,
        batchTracked: true,
        expiryTracked: true,
        safetyStock: 2000,
        minStock: 5000,
        standardCost: 850,
      },
    });
    const row = await db.product.findUniqueOrThrow({ where: { id: sugar.id } });
    check('sugar is a raw material', row.manufacturingType === 'RAW_MATERIAL');
    check('bought but not sold', row.purchaseEnabled && !row.sellable);
    check('tracked by batch and expiry', row.batchTracked && row.expiryTracked);
    check('with planning levels', Number(row.safetyStock) === 2000 && Number(row.minStock) === 5000);

    // It is still an ordinary product to everything else — that is the point
    // of extending rather than duplicating.
    const page = await as(factoryId, () => catalogService.listProducts({ limit: 50 } as never));
    check('and it still appears in the ordinary catalogue',
      page.items.some((p: { id: string }) => p.id === sugar.id));
  }

  console.log('\n=== 4. WAREHOUSES CAN BE CLASSIFIED WITHOUT BEING REPLACED ===');
  {
    const raw = await as(factoryId, () =>
      inventoryService.createWarehouse({ name: 'Lagos Raw Materials', code: `LRM${stamp}`.slice(0, 20) } as never),
    );
    await db.warehouse.update({ where: { id: raw.id }, data: { warehouseType: 'RAW_MATERIAL' } });
    const row = await db.warehouse.findUniqueOrThrow({ where: { id: raw.id } });
    check('a raw-material store is the same Warehouse row', row.warehouseType === 'RAW_MATERIAL');
    check('holding stock the same way', row.isActive === true);
  }

  console.log('\n=== 5. THE MANUFACTURING TABLES EXIST AND ARE EMPTY ===');
  {
    // A business that has never made anything should have nothing in any of
    // them; the module being available is not the same as it being used.
    const counts = await Promise.all([
      db.billOfMaterial.count({ where: { organizationId: factoryId } }),
      db.productionOrder.count({ where: { organizationId: factoryId } }),
      db.batch.count({ where: { organizationId: factoryId } }),
      db.qualityInspection.count({ where: { organizationId: factoryId } }),
      db.productionLine.count({ where: { organizationId: factoryId } }),
      db.equipment.count({ where: { organizationId: factoryId } }),
    ]);
    check('nothing is created merely by having the module', counts.every((c) => c === 0));
    check('and the shop has nothing either',
      (await db.billOfMaterial.count({ where: { organizationId: shopId } })) === 0);
  }

  console.log('\n=== 6. A RECIPE SCALES, AND KNOWS ABOUT WASTAGE ===');
  const ctx = await buildFactory();
  {
    const bom = await as(factoryId, () =>
      bomService.create({
        productId: ctx.drinkId,
        outputQuantity: 1000,
        activate: true,
        items: [
          { variantId: ctx.sugarVariantId, quantity: 650, unit: 'kg', scrapPercent: 0 },
          // Bottles are lost in handling, so more must be bought than the
          // recipe literally calls for.
          { variantId: ctx.bottleVariantId, quantity: 12000, unit: 'each', scrapPercent: 2 },
        ],
      } as never),
    );
    check('the recipe is active', bom.status === 'ACTIVE');
    check('and is version 1', bom.version === 1);

    const req = await as(factoryId, () => bomService.requirementsFor(bom.id, 2000));
    const sugar = req.items.find((i) => i.variantId === ctx.sugarVariantId)!;
    const bottles = req.items.find((i) => i.variantId === ctx.bottleVariantId)!;
    // Twice the batch size means twice the sugar.
    check('doubling the run doubles the sugar', sugar.requiredQuantity === 1300, String(sugar.requiredQuantity));
    // 24,000 plus 2% wastage.
    check('and bottles are grossed up for wastage',
      bottles.requiredQuantity === 24480, String(bottles.requiredQuantity));
    ctx.bomId = bom.id;
  }

  console.log('\n=== 7. A SECOND VERSION SUPERSEDES THE FIRST ===');
  {
    const v2 = await as(factoryId, () =>
      bomService.create({
        productId: ctx.drinkId,
        outputQuantity: 1000,
        activate: true,
        items: [{ variantId: ctx.sugarVariantId, quantity: 600, unit: 'kg' }],
      } as never),
    );
    check('the new one is version 2', v2.version === 2);
    const first = await as(factoryId, () => bomService.get(ctx.bomId));
    // Two active recipes would mean production picks one at random.
    check('and the first is no longer active', first.status !== 'ACTIVE');
    const active = await as(factoryId, () => bomService.activeFor(ctx.drinkId));
    check('exactly one is active', active?.id === v2.id);

    // An active recipe is referenced by orders and cannot be edited underneath
    // them; supersede it instead.
    let refused = false;
    try {
      await as(factoryId, () => bomService.update(v2.id, { outputQuantity: 500 } as never));
    } catch { refused = true; }
    check('an active recipe cannot be edited in place', refused);

    // Put the fuller recipe back for the run below.
    await as(factoryId, () => bomService.activate(ctx.bomId));
    check('and an older version can be made active again',
      (await as(factoryId, () => bomService.activeFor(ctx.drinkId)))?.id === ctx.bomId);
  }

  console.log('\n=== 8. A PRODUCT CANNOT BE MADE FROM ITSELF ===');
  {
    let refused = false;
    try {
      await as(factoryId, () =>
        bomService.create({
          productId: ctx.drinkId,
          outputQuantity: 100,
          items: [{ variantId: ctx.drinkVariantId, quantity: 1 }],
        } as never),
      );
    } catch { refused = true; }
    check('a self-referencing recipe is refused', refused);
  }

  console.log('\n=== 9. AN ORDER FREEZES WHAT IT NEEDS ===');
  {
    const order = await as(factoryId, () =>
      productionOrdersService.create({
        productId: ctx.drinkId,
        plannedQuantity: 2000,
        warehouseId: ctx.rawWarehouseId,
        finishedWarehouseId: ctx.finishedWarehouseId,
        priority: 'NORMAL',
      } as never),
    );
    ctx.orderId = order.id;
    check('the order is raised as a draft', order.status === 'DRAFT');

    const full = await as(factoryId, () => productionOrdersService.get(order.id));
    const sugar = full.materials.find((m) => m.variant.id === ctx.sugarVariantId)!;
    check('with the sugar it needs worked out from the recipe',
      Number(sugar.requiredQuantity) === 1300, String(sugar.requiredQuantity));
    check('and nothing issued yet', Number(sugar.issuedQuantity) === 0);
  }

  console.log('\n=== 10. THE SHORTAGE CHECK TELLS THE TRUTH ===');
  {
    // 1,000kg on the shelf against 1,300kg required.
    const checkResult = await as(factoryId, () => productionOrdersService.materialCheck(ctx.orderId));
    const sugar = checkResult.items.find((i) => i.variantId === ctx.sugarVariantId)!;
    check('it reports the shortfall', sugar.shortfallQuantity === 300, String(sugar.shortfallQuantity));
    check('and names it a shortage', sugar.status === 'SHORTAGE', sugar.status);
    check('so the run cannot simply proceed', checkResult.canProceed === false);
    check('and it says how many materials are short', checkResult.shortageCount >= 1);
  }

  console.log('\n=== 11. MATERIAL LEAVES THE STORE ONLY WHEN ISSUED ===');
  {
    await as(factoryId, () => productionOrdersService.transition(ctx.orderId, 'APPROVED'));
    await as(factoryId, () => productionOrdersService.transition(ctx.orderId, 'IN_PROGRESS'));

    const before = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.sugarVariantId },
    });
    await as(factoryId, () =>
      materialConsumptionService.issue(
        ctx.orderId,
        { warehouseId: ctx.rawWarehouseId, items: [{ variantId: ctx.sugarVariantId, quantity: 900 }] } as never,
        userId,
      ),
    );
    const after = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.sugarVariantId },
    });
    check('stock falls by what was issued',
      Number(before.quantity) - Number(after.quantity) === 900,
      `${Number(before.quantity)} → ${Number(after.quantity)}`);

    // §19: never a silent change.
    const movement = await db.stockMovement.findFirst({
      where: { referenceId: ctx.orderId, type: 'MATERIAL_ISSUE' },
      orderBy: { createdAt: 'desc' },
    });
    check('and an auditable movement is written', movement !== null);
    check('naming the production order it went to', movement?.referenceType === 'PRODUCTION_ORDER');
  }

  console.log('\n=== 12. ISSUING MORE THAN EXISTS ROLLS EVERYTHING BACK ===');
  {
    const before = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.sugarVariantId },
    });
    const movementsBefore = await db.stockMovement.count({ where: { referenceId: ctx.orderId } });

    let refused = false;
    try {
      // The bottles would succeed; the sugar cannot. §32 says neither happens.
      await as(factoryId, () =>
        materialConsumptionService.issue(
          ctx.orderId,
          {
            warehouseId: ctx.rawWarehouseId,
            items: [
              { variantId: ctx.bottleVariantId, quantity: 100 },
              { variantId: ctx.sugarVariantId, quantity: 999999 },
            ],
          } as never,
          userId,
        ),
      );
    } catch { refused = true; }

    check('the impossible issue is refused', refused);
    const after = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.sugarVariantId },
    });
    check('the sugar is untouched', Number(after.quantity) === Number(before.quantity));
    // The bottles must not have moved either, or the transaction was not atomic.
    const bottles = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.bottleVariantId },
    });
    check('and so are the bottles that would have succeeded',
      Number(bottles.quantity) === ctx.bottleOpeningStock, String(Number(bottles.quantity)));
    check('with no half-written movements left behind',
      (await db.stockMovement.count({ where: { referenceId: ctx.orderId } })) === movementsBefore);
  }

  console.log('\n=== 13. CONSUMING MORE THAN WAS ISSUED IS REFUSED ===');
  {
    // Otherwise variance becomes unexplainable: material was used that no
    // movement ever accounted for.
    let refused = false;
    try {
      await as(factoryId, () =>
        materialConsumptionService.consume(
          ctx.orderId,
          { items: [{ variantId: ctx.sugarVariantId, quantity: 5000 }] } as never,
          userId,
        ),
      );
    } catch { refused = true; }
    check('using more than left the store is refused', refused);

    await as(factoryId, () =>
      materialConsumptionService.consume(
        ctx.orderId,
        { items: [{ variantId: ctx.sugarVariantId, quantity: 880 }] } as never,
        userId,
      ),
    );
    const material = await db.productionMaterial.findFirstOrThrow({
      where: { productionOrderId: ctx.orderId, variantId: ctx.sugarVariantId },
    });
    check('what was really used is recorded', Number(material.consumedQuantity) === 880);
    // 900 issued, 880 used — the 20kg difference is the variance, and it only
    // exists because the two are tracked separately.
    check('and differs from what was issued', Number(material.issuedQuantity) === 900);
  }

  console.log('\n=== 14. OUTPUT BOOKS IN GOOD STOCK ONLY ===');
  {
    const result = await as(factoryId, () =>
      productionOutputService.record(
        ctx.orderId,
        { producedQuantity: 1900, rejectedQuantity: 100 } as never,
        userId,
      ),
    );
    check('good quantity is produced minus rejects', result.goodQuantity === 1800);
    check('a batch number was generated', Boolean(result.batchNumber), String(result.batchNumber));
    check('and it is held for quality control', result.heldForQualityControl === true);

    const level = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.finishedWarehouseId, variantId: ctx.drinkVariantId },
    });
    // The rejected 100 must never become sellable stock.
    check('only the good cases reach the store', Number(level.quantity) === 1800);
    check('and none of it is available until inspected', Number(level.reserved) === 1800);
    ctx.batchId = result.batchId!;
  }

  console.log('\n=== 15. A BATCH CAN BE TRACED TO ITS SUPPLIER ===');
  {
    const trace = await as(factoryId, () => batchesService.trace(ctx.batchId));
    check('the batch knows the run that made it',
      trace.productionOrder?.id === ctx.orderId);
    check('the run knows what it consumed', trace.materials.length >= 1);
    const sugar = trace.materials.find((m) => m.variantId === ctx.sugarVariantId)!;
    check('including how much sugar went in', sugar.consumedQuantity === 880);
    // Nothing recorded a lot number on the way in, so the chain is honestly
    // reported as incomplete rather than invented.
    check('and says plainly where the chain breaks', trace.fullyTraceable === false);
    check('naming the material it cannot trace',
      trace.untraceableMaterials.length >= 1, trace.untraceableMaterials.join(','));
  }

  console.log('\n=== 16. THE LIFECYCLE CANNOT BE SKIPPED ===');
  {
    let refused = false;
    try {
      // Straight from in-progress back to draft would rewrite history.
      await as(factoryId, () => productionOrdersService.transition(ctx.orderId, 'DRAFT'));
    } catch { refused = true; }
    check('a run in progress cannot go back to draft', refused);

    await as(factoryId, () => productionOrdersService.transition(ctx.orderId, 'COMPLETED'));
    let refusedAfter = false;
    try {
      await as(factoryId, () => productionOrdersService.transition(ctx.orderId, 'IN_PROGRESS'));
    } catch { refusedAfter = true; }
    check('and a completed one cannot be restarted', refusedAfter);
  }

  console.log('\n=== 17. A PLAN IS AN INTENTION, NOT A COMMITMENT ===');
  {
    const plan = await as(factoryId, () =>
      productionPlanningService.create({
        productId: ctx.drinkId,
        quantity: 5000,
        productionDate: new Date(Date.now() + 3 * 86_400_000),
        warehouseId: ctx.rawWarehouseId,
        priority: 'HIGH',
      } as never),
    );
    ctx.planId = plan.id;
    check('it starts as a draft', plan.status === 'DRAFT');

    // Asking what it would need must not reserve or move anything.
    const before = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.sugarVariantId },
    });
    const req = await as(factoryId, () => productionPlanningService.requirements(plan.id));
    const sugar = req.items.find((i) => i.variantId === ctx.sugarVariantId)!;
    check('and says what it would need', sugar.requiredQuantity === 3250, String(sugar.requiredQuantity));
    const after = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: ctx.sugarVariantId },
    });
    check('without reserving anything', Number(after.reserved) === Number(before.reserved));

    // A plan cannot become an order until somebody approves it.
    let refused = false;
    try {
      await as(factoryId, () => productionPlanningService.raiseOrder(plan.id));
    } catch { refused = true; }
    check('an unapproved plan cannot become an order', refused);

    await as(factoryId, () => productionPlanningService.transition(plan.id, 'PLANNED'));
    await as(factoryId, () => productionPlanningService.transition(plan.id, 'APPROVED'));
    const order = await as(factoryId, () => productionPlanningService.raiseOrder(plan.id));
    check('once approved it raises a production order', Boolean(order.orderNumber));
    ctx.plannedOrderId = order.id;

    const reloaded = await as(factoryId, () => productionPlanningService.get(plan.id));
    check('and the plan tracks the order it raised', reloaded.orders.length === 1);
    check('moving to in progress', reloaded.status === 'IN_PROGRESS');
  }

  console.log('\n=== 18. A SHORTAGE IS DIAGNOSED, NOT JUST REPORTED ===');
  {
    // 3,250kg needed against ~100kg left after the earlier run.
    const rec = await as(factoryId, () =>
      procurementRecommendationsService.forProductionOrder(ctx.plannedOrderId),
    );
    check('it finds the shortage', rec.shortageCount >= 1);
    const sugar = rec.recommendations.find((r) => r.variantId === ctx.sugarVariantId)!;
    check('naming the material', sugar.sku.startsWith('SUG-'));

    // Buying exactly the shortfall leaves the business at zero the moment the
    // run ends, so safety stock is added.
    check('and suggests buying more than the bare shortfall',
      sugar.suggestedPurchaseQuantity > sugar.shortfallQuantity,
      `${sugar.suggestedPurchaseQuantity} vs ${sugar.shortfallQuantity}`);
    check('by exactly the safety stock', 
      Math.abs(sugar.suggestedPurchaseQuantity - (sugar.shortfallQuantity + sugar.safetyStock)) < 0.01);

    // No supplier attached yet, so there is nobody to buy from and it says so
    // rather than inventing one.
    check('with no supplier it recommends nothing to buy',
      sugar.recommendedAction === 'NO_SUPPLIER', sugar.recommendedAction);
    check('and lists it as unsourced', rec.unsourced.includes(sugar.sku));
  }

  console.log('\n=== 19. NOTHING IS BOUGHT WITHOUT A SUPPLIER, OR A PERSON ===');
  {
    let refused = false;
    try {
      await as(factoryId, () =>
        procurementRecommendationsService.createDraftPurchaseOrders(ctx.plannedOrderId, {} as never),
      );
    } catch { refused = true; }
    check('with no supplier, no order can be raised', refused);

    // Attach one, the way the buying team already would.
    const supplier = await db.supplier.create({
      data: { organizationId: factoryId, name: 'Prime Sugar Industries Ltd', leadTimeDays: 7 },
    });
    await db.supplierProduct.create({
      data: {
        organizationId: factoryId, supplierId: supplier.id, productId: ctx.sugarProductId,
        costPrice: 850, isPreferred: true, minOrderQty: 1000, leadTimeDays: 7,
      },
    });

    const rec = await as(factoryId, () =>
      procurementRecommendationsService.forProductionOrder(ctx.plannedOrderId),
    );
    const sugar = rec.recommendations.find((r) => r.variantId === ctx.sugarVariantId)!;
    check('now it knows who to buy from', sugar.preferredSupplier?.name === 'Prime Sugar Industries Ltd');
    check('and recommends purchasing', sugar.recommendedAction === 'PURCHASE');
    check('with the lead time attached', sugar.preferredSupplier?.leadTimeDays === 7);

    const posBefore = await db.purchaseOrder.count({ where: { organizationId: factoryId } });
    // Looking at a recommendation must never create anything.
    check('reading a recommendation creates nothing', posBefore === 0);

    const result = await as(factoryId, () =>
      procurementRecommendationsService.createDraftPurchaseOrders(
        ctx.plannedOrderId, { notes: 'Check pricing before sending' } as never),
    );
    check('acting on it creates an order', result.draftPurchaseOrders.length === 1);

    const po = await db.purchaseOrder.findFirstOrThrow({ where: { organizationId: factoryId } });
    // §8: never sent without a person agreeing.
    check('and it is a draft, not sent to the supplier', po.status === 'DRAFT', po.status);
    const line = await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    check('for the recommended quantity', Number(line.quantity) === sugar.suggestedPurchaseQuantity);
  }

  console.log('\n=== 20. WHAT IS ALREADY IN THE BUSINESS IS MOVED, NOT BOUGHT ===');
  {
    // Put plenty in the finished-goods store, which is not the production one.
    await as(factoryId, () =>
      inventoryService.adjustStock(
        { variantId: ctx.sugarVariantId, warehouseId: ctx.finishedWarehouseId, quantityChange: 9000 } as never,
        userId),
    );
    const rec = await as(factoryId, () =>
      procurementRecommendationsService.forProductionOrder(ctx.plannedOrderId),
    );
    const sugar = rec.recommendations.find((r) => r.variantId === ctx.sugarVariantId)!;
    // Buying what is already sitting in the next warehouse wastes money.
    check('it now recommends moving it instead', sugar.recommendedAction === 'TRANSFER');
    check('naming the store that has it', sugar.availableElsewhere.length >= 1);

    const requisition = await as(factoryId, () =>
      procurementRecommendationsService.requestFromWarehouse(ctx.plannedOrderId, {
        fromWarehouseId: ctx.finishedWarehouseId,
        reason: 'Materials for the planned run',
      } as never),
    );
    // §11: the existing internal requisition, not a manufacturing-only transfer.
    check('and raises an ordinary internal requisition',
      Boolean((requisition as { number?: string }).number));
    const saved = await db.internalRequisition.findFirstOrThrow({
      where: { organizationId: factoryId },
    });
    check('addressed to the production warehouse', saved.toWarehouseId === ctx.rawWarehouseId);
    check('from the store that has the stock', saved.fromWarehouseId === ctx.finishedWarehouseId);
  }

  // A second run, so a failed inspection has its own batch to act on.
  {
    const order2 = await as(factoryId, () =>
      productionOrdersService.create({
        productId: ctx.drinkId, plannedQuantity: 500,
        warehouseId: ctx.rawWarehouseId, finishedWarehouseId: ctx.finishedWarehouseId,
      } as never),
    );
    ctx.orderId2 = order2.id;
    await as(factoryId, () => productionOrdersService.transition(order2.id, 'APPROVED'));
    await as(factoryId, () => productionOrdersService.transition(order2.id, 'IN_PROGRESS'));
  }

  console.log('\n=== 21. QUALITY IS CHECKED AGAINST WHAT WAS EXPECTED ===');
  {
    await as(factoryId, () =>
      qualityControlService.createParameter({
        productId: ctx.drinkId, name: 'pH', unit: 'pH',
        expectedMin: 3.2, expectedMax: 3.8, isRequired: true, position: 0,
      } as never),
    );
    await as(factoryId, () =>
      qualityControlService.createParameter({
        productId: ctx.drinkId, name: 'Packaging integrity',
        expectedText: 'Intact', isRequired: true, position: 1,
      } as never),
    );

    const inspection = await as(factoryId, () =>
      qualityControlService.create({ variantId: ctx.drinkVariantId, batchId: ctx.batchId } as never, userId),
    );
    ctx.inspectionId = inspection.id;
    // The checklist is pre-filled so an inspector does not decide for
    // themselves what to measure.
    check('the inspection is pre-filled from the product', inspection.items.length === 2);
    check('and starts pending', inspection.status === 'PENDING');

    const ph = inspection.items.find((i) => i.name === 'pH')!;
    const pack = inspection.items.find((i) => i.name === 'Packaging integrity')!;
    const withResults = await as(factoryId, () =>
      qualityControlService.recordResults(inspection.id, {
        items: [
          { itemId: ph.id, actualNumeric: 3.5 },
          { itemId: pack.id, actualValue: 'Intact' },
        ],
      } as never),
    );
    const judgedPh = withResults.items.find((i) => i.name === 'pH')!;
    check('a reading inside the range passes on its own', judgedPh.passed === true);
    check('and matching text passes too',
      withResults.items.find((i) => i.name === 'Packaging integrity')!.passed === true);
  }

  console.log('\n=== 22. PASSING RELEASES WHAT PRODUCTION WAS HOLDING ===');
  {
    const before = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.finishedWarehouseId, variantId: ctx.drinkVariantId },
    });
    check('the stock is still held before the verdict', Number(before.reserved) === 1800);

    await as(factoryId, () =>
      qualityControlService.conclude(ctx.inspectionId, { status: 'PASSED' } as never, userId),
    );
    const after = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.finishedWarehouseId, variantId: ctx.drinkVariantId },
    });
    // The whole point: quality is not a note, it is what makes stock sellable.
    check('passing frees it for sale', Number(after.reserved) === 0, String(Number(after.reserved)));
    check('and the cases are still there', Number(after.quantity) === 1800);

    const batch = await db.batch.findUniqueOrThrow({ where: { id: ctx.batchId } });
    check('the batch is marked passed', batch.qcStatus === 'PASSED');
    check('and is not quarantined', batch.isQuarantined === false);
  }

  console.log('\n=== 23. A FAILED READING CANNOT BE WAVED THROUGH ===');
  {
    const second = await as(factoryId, () =>
      productionOutputService.record(
        ctx.orderId2, { producedQuantity: 500, rejectedQuantity: 0 } as never, userId),
    );
    ctx.batchId2 = second.batchId!;
    const inspection = await as(factoryId, () =>
      qualityControlService.create({ variantId: ctx.drinkVariantId, batchId: ctx.batchId2 } as never, userId),
    );
    const ph = inspection.items.find((i) => i.name === 'pH')!;
    await as(factoryId, () =>
      qualityControlService.recordResults(inspection.id, {
        items: [{ itemId: ph.id, actualNumeric: 5.9 }],
      } as never),
    );
    const judged = await as(factoryId, () => qualityControlService.get(inspection.id));
    check('a reading outside the range fails',
      judged.items.find((i) => i.name === 'pH')!.passed === false);

    // Passing a batch whose reading failed is the one mistake a quality system
    // must not allow.
    let refused = false;
    try {
      await as(factoryId, () =>
        qualityControlService.conclude(inspection.id, { status: 'PASSED' } as never, userId),
      );
    } catch { refused = true; }
    check('it cannot then be concluded as a pass', refused);

    // And a failure has to be explained.
    let needsReason = false;
    try {
      await as(factoryId, () =>
        qualityControlService.conclude(inspection.id, { status: 'FAILED' } as never, userId),
      );
    } catch { needsReason = true; }
    check('failing without a reason is refused', needsReason);

    await as(factoryId, () =>
      qualityControlService.conclude(
        inspection.id, { status: 'FAILED', reason: 'pH out of specification' } as never, userId),
    );
    const batch = await db.batch.findUniqueOrThrow({ where: { id: ctx.batchId2 } });
    check('failing quarantines the batch', batch.isQuarantined === true);
    check('and marks it failed', batch.qcStatus === 'FAILED');
  }

  console.log('\n=== 24. QUARANTINED STOCK CANNOT BE SOLD OR MOVED ===');
  {
    const level = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.finishedWarehouseId, variantId: ctx.drinkVariantId },
    });
    // 1,800 released earlier plus 500 held now.
    check('the held cases are reserved', Number(level.reserved) === 500, String(Number(level.reserved)));

    // §15: not sellable, not transferable. Enforced by the same reserve rule
    // every other part of the product already obeys.
    let refused = false;
    try {
      await as(factoryId, () =>
        inventoryService.createTransfer(
          {
            fromWarehouseId: ctx.finishedWarehouseId,
            toWarehouseId: ctx.rawWarehouseId,
            items: [{ variantId: ctx.drinkVariantId, quantity: 2000 }],
          } as never,
          userId,
        ),
      );
    } catch { refused = true; }
    check('a transfer that would dip into held stock is refused', refused);

    // The unheld portion still moves freely — holding a batch must not freeze
    // the whole warehouse.
    await as(factoryId, () =>
      inventoryService.createTransfer(
        {
          fromWarehouseId: ctx.finishedWarehouseId,
          toWarehouseId: ctx.rawWarehouseId,
          items: [{ variantId: ctx.drinkVariantId, quantity: 100 }],
        } as never,
        userId,
      ),
    );
    check('while released stock still moves normally', true);
  }

  console.log('\n=== 25. A HELD BATCH IS DECIDED, AND THE DECISION IS ANSWERABLE ===');
  {
    const held = await as(factoryId, () => quarantineService.list({ status: 'HELD' }));
    check('the batch is on the quarantine list', held.length === 1);
    const record = held[0]!;
    check('with the reason it was held', record.reason === 'pH out of specification');

    const before = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.finishedWarehouseId, variantId: ctx.drinkVariantId },
    });

    /*
     * Every decision needs a reason — releasing or writing off failed stock is
     * exactly what somebody has to answer for later. The requirement lives in
     * the schema the route validates against, so it is asserted there rather
     * than by calling the service, which by convention receives input that has
     * already been checked.
     */
    const withoutReason = quarantineDecisionSchema.safeParse({ decision: 'REJECTED' });
    check('a decision without a reason is refused', withoutReason.success === false);
    const withReason = quarantineDecisionSchema.safeParse({
      decision: 'REJECTED', reason: 'Unsalvageable',
    });
    check('and one with a reason is accepted', withReason.success === true);

    await as(factoryId, () =>
      quarantineService.decide(
        record.id,
        { decision: 'REJECTED', reason: 'Unsalvageable — disposed of on site' } as never,
        userId,
      ),
    );

    const after = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.finishedWarehouseId, variantId: ctx.drinkVariantId },
    });
    check('rejecting writes the stock off',
      Number(before.quantity) - Number(after.quantity) === 500,
      `${Number(before.quantity)} → ${Number(after.quantity)}`);
    check('and the hold is lifted with it', Number(after.reserved) === 0);

    const movement = await db.stockMovement.findFirst({
      where: { referenceId: ctx.batchId2, type: 'QC_REJECTION' },
    });
    check('with an auditable rejection movement', movement !== null);

    const audit = await db.auditLog.findFirst({
      where: { organizationId: factoryId, action: 'qc.batch_rejected' },
    });
    check('and an audit entry carrying the reason',
      audit?.reason === 'Unsalvageable — disposed of on site');
  }

  console.log('\n=== 26. A LINE THAT IS DOWN CANNOT RUN PRODUCTION ===');
  {
    const line = await as(factoryId, () =>
      productionLinesService.create({ name: 'Production Line 1', code: `PL1-${stamp}`.slice(0, 20) } as never),
    );
    ctx.lineId = line.id;
    check('a new line is operational', line.status === 'OPERATIONAL');
    await as(factoryId, () => productionLinesService.assertRunnable(line.id));
    check('and production may start on it', true);

    await as(factoryId, () =>
      productionLinesService.update(line.id, { status: 'BREAKDOWN' } as never));
    let refused = false;
    try {
      await as(factoryId, () => productionLinesService.assertRunnable(line.id));
    } catch { refused = true; }
    // Recording that a machine is down has to actually stop work being put on
    // it, or the status is decoration.
    check('a broken line refuses production', refused);

    const audit = await db.auditLog.findFirst({
      where: { organizationId: factoryId, action: 'production_line.status_changed' },
    });
    check('and going down is separately auditable', audit !== null);
    await as(factoryId, () => productionLinesService.update(line.id, { status: 'OPERATIONAL' } as never));
  }

  console.log('\n=== 27. AN EMERGENCY TAKES THE MACHINE OUT OF SERVICE ===');
  {
    const machine = await as(factoryId, () =>
      equipmentService.create({
        name: 'Filler #1', code: `FIL-${stamp}`.slice(0, 40),
        productionLineId: ctx.lineId, maintenanceFrequencyDays: 90,
        lastMaintenanceAt: new Date(Date.now() - 100 * 86_400_000),
      } as never),
    );
    ctx.equipmentId = machine.id;
    // A service interval with no next date is a machine that quietly never
    // gets serviced.
    check('its next service is worked out from the interval', machine.nextMaintenanceAt !== null);
    check('and it is already overdue',
      machine.nextMaintenanceAt !== null && machine.nextMaintenanceAt < new Date());

    const due = await as(factoryId, () => equipmentService.list({ dueOnly: true }));
    check('so it appears on the due list', due.some((e) => e.id === machine.id));

    const wo = await as(factoryId, () =>
      equipmentService.createWorkOrder({
        equipmentId: machine.id, type: 'EMERGENCY',
        issue: 'Filler jammed mid-run', priority: 'EMERGENCY',
      } as never),
    );
    ctx.workOrderId = wo.id;
    const after = await db.equipment.findUniqueOrThrow({ where: { id: machine.id } });
    // Otherwise a run gets scheduled onto a machine that cannot run.
    check('an emergency marks the machine broken down', after.status === 'BREAKDOWN');
  }

  console.log('\n=== 28. FITTING A PART TAKES IT OUT OF STOCK ===');
  {
    const part = await as(factoryId, () =>
      catalogService.createProduct({
        name: 'Filler seal kit', status: 'ACTIVE', taxRate: 0, unit: 'each',
        variants: [{ sku: `SEAL-${stamp}`, price: 0, costPrice: 4500, isDefault: true }],
      } as never),
    );
    const partVariant = await db.productVariant.findFirstOrThrow({ where: { productId: part.id } });
    await db.product.update({
      where: { id: part.id }, data: { manufacturingType: 'SPARE_PART', sellable: false },
    });
    await as(factoryId, () =>
      inventoryService.adjustStock(
        { variantId: partVariant.id, warehouseId: ctx.rawWarehouseId, quantityChange: 5 } as never, userId),
    );

    await as(factoryId, () => equipmentService.startWorkOrder(ctx.workOrderId));
    const duringRepair = await db.equipment.findUniqueOrThrow({ where: { id: ctx.equipmentId } });
    check('starting the job puts the machine under maintenance', duringRepair.status === 'MAINTENANCE');

    await as(factoryId, () =>
      equipmentService.completeWorkOrder(
        ctx.workOrderId,
        {
          downtimeMinutes: 240, cost: 15000,
          parts: [{ variantId: partVariant.id, warehouseId: ctx.rawWarehouseId, quantity: 2, unitCost: 4500 }],
        } as never,
        userId,
      ),
    );

    const level = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: ctx.rawWarehouseId, variantId: partVariant.id },
    });
    // A maintenance system that records parts on the work order but not in
    // inventory leaves the store wrong by exactly the parts fitted.
    check('the seals leave the store', Number(level.quantity) === 3, String(Number(level.quantity)));
    const movement = await db.stockMovement.findFirst({
      where: { variantId: partVariant.id, type: 'MAINTENANCE_CONSUMPTION' },
    });
    check('with a movement of their own', movement !== null);

    const wo = await as(factoryId, () => equipmentService.getWorkOrder(ctx.workOrderId));
    check('the work order is completed', wo.status === 'COMPLETED');
    check('downtime is recorded', wo.downtimeMinutes === 240);
    // Labour plus parts, so "what did this cost" needs one read.
    check('and cost includes the parts', Number(wo.cost) === 15000 + 9000, String(Number(wo.cost)));

    const machine = await db.equipment.findUniqueOrThrow({ where: { id: ctx.equipmentId } });
    check('the machine is back in service', machine.status === 'OPERATIONAL');
    check('and its next service has moved on',
      machine.nextMaintenanceAt !== null && machine.nextMaintenanceAt > new Date());
  }

  console.log('\n=== 29. A RUN IS COSTED AGAINST WHAT IT SHOULD HAVE COST ===');
  {
    const costing = await as(factoryId, () =>
      costingService.calculate(ctx.orderId, { labourCost: 50000, overheadCost: 20000 } as never),
    );
    // 880kg consumed at 850, against 1,300kg planned.
    check('material cost comes from what was really consumed',
      costing.cost.materialCost === 880 * 850, String(costing.cost.materialCost));
    check('the estimate comes from the recipe',
      costing.estimate.estimatedCost > costing.cost.totalCost - 70000,
      `${costing.estimate.estimatedCost}`);
    // Using less than planned is an underspend, not an overspend.
    check('so using less shows as a saving', costing.costVariance < 0, String(costing.costVariance));

    check('unit cost is per good case, not per case attempted',
      costing.cost.unitCost !== null &&
      Math.abs(costing.cost.unitCost - costing.cost.totalCost / 1800) < 0.01);

    // 1,800 good against 2,000 planned.
    check('yield is good output over planned', costing.output.yieldPercent === 90,
      String(costing.output.yieldPercent));
    // Against what was actually produced (100 of 1,900), not against what was
    // planned — a run that made less than intended did not thereby reject more.
    check('and the rejection rate is a share of real output',
      costing.output.rejectionRatePercent === 5.26,
      String(costing.output.rejectionRatePercent));

    const sugar = costing.materialVariances.find((v) => v.variantId === ctx.sugarVariantId)!;
    check('the sugar variance is recorded', sugar.varianceQuantity === -420, String(sugar.varianceQuantity));
    check('as a percentage too', sugar.variancePercent !== null);
    // Only overconsumption counts against tolerance.
    check('and using less does not count as an exception', sugar.exceedsThreshold === false);
  }

  console.log('\n=== 30. A COST IS A SNAPSHOT, NOT A LIVE SUM ===');
  {
    const stored = await as(factoryId, () => costingService.forOrder(ctx.orderId));
    const originalTotal = Number(stored.cost.totalCost);

    // Prices move. Last quarter's cost must not change because this quarter's
    // sugar did.
    await db.productVariant.update({
      where: { id: ctx.sugarVariantId }, data: { costPrice: 2000 },
    });
    const again = await as(factoryId, () => costingService.forOrder(ctx.orderId));
    check('a stored cost does not move when prices do',
      Number(again.cost.totalCost) === originalTotal);

    // Recalculating replaces rather than accumulates — a run has one cost.
    await as(factoryId, () =>
      costingService.calculate(ctx.orderId, { labourCost: 50000, overheadCost: 20000 } as never),
    );
    const rows = await db.productionCost.count({ where: { productionOrderId: ctx.orderId } });
    check('and recalculating leaves exactly one', rows === 1, String(rows));
    const recalculated = await as(factoryId, () => costingService.forOrder(ctx.orderId));
    check('reflecting the new price', Number(recalculated.cost.totalCost) > originalTotal);
  }

  console.log('\n=== 31. THE DASHBOARD COUNTS WHAT ACTUALLY HAPPENED ===');
  {
    const view = await as(factoryId, () => manufacturingDashboard.overview());

    // 1,800 good from the first run + 500 from the second, both this month.
    check('production this month is good output only',
      view.production.thisMonth === 2300, String(view.production.thisMonth));
    check('and rejects are reported separately',
      view.production.rejectedInPeriod === 100, String(view.production.rejectedInPeriod));

    // One completed run planned 2,000 and made 1,800 good.
    check('efficiency is good output against planned',
      view.production.efficiencyPercent === 90, String(view.production.efficiencyPercent));

    check('orders are counted by status', view.orders.total >= 3);
    check('with the completed one counted', view.orders.completed >= 1);

    /*
     * A draft is not pending, and a draft purchase order is not outstanding.
     * Nothing has been asked of anybody yet in either case, and counting them
     * would show a queue of work that does not exist.
     */
    check('a draft purchase order is not counted as open',
      view.materials.openPurchaseOrders === 0, String(view.materials.openPurchaseOrders));
    check('and a draft requisition is not counted as pending',
      view.materials.pendingRequisitions === 0, String(view.materials.pendingRequisitions));

    /*
     * Sugar is nearly gone from the production store but plentiful in the
     * finished-goods one, and the floor is a business-wide figure. So this is
     * not a shortage — it is stock in the wrong place, which is a transfer,
     * not a purchase. Reporting it as low would send a buyer to a supplier for
     * something already paid for.
     */
    const sugarLow = view.materials.lowStock.find((m) => m.productId === ctx.sugarProductId);
    check('material held elsewhere is not reported as low', sugarLow === undefined);

    // Take it out of the other store and it genuinely is short.
    await as(factoryId, () =>
      inventoryService.adjustStock(
        { variantId: ctx.sugarVariantId, warehouseId: ctx.finishedWarehouseId, quantityChange: -9000 } as never,
        userId),
    );
    const atFloor = await as(factoryId, () => manufacturingDashboard.overview());
    const sittingOnFloor = atFloor.materials.lowStock.find((m) => m.productId === ctx.sugarProductId);
    // Exactly at the safety level: the buffer is gone, so this is the moment
    // to say so rather than one run later.
    check('sitting exactly on the floor is already a warning', sittingOnFloor !== undefined);
    check('reported with nothing yet missing',
      sittingOnFloor?.shortBy === 0, String(sittingOnFloor?.shortBy));

    await as(factoryId, () =>
      inventoryService.adjustStock(
        { variantId: ctx.sugarVariantId, warehouseId: ctx.rawWarehouseId, quantityChange: -60 } as never,
        userId),
    );
    const belowFloor = await as(factoryId, () => manufacturingDashboard.overview());
    const nowLow = belowFloor.materials.lowStock.find((m) => m.productId === ctx.sugarProductId);
    check('and once below it, the gap is quantified',
      nowLow !== undefined && nowLow.shortBy === 60, String(nowLow?.shortBy));

    check('quarantined batches are counted', view.quality.quarantinedBatches >= 0);
    check('and downtime is in hours as well as minutes',
      view.maintenance.downtimeMinutes === 240 && view.maintenance.downtimeHours === 4,
      `${view.maintenance.downtimeMinutes}m / ${view.maintenance.downtimeHours}h`);
    check('with maintenance cost included',
      view.maintenance.maintenanceCost === 24000, String(view.maintenance.maintenanceCost));
  }

  console.log('\n=== 32. INVENTORY IS VALUED AT COST, NOT AT SELLING PRICE ===');
  {
    const value = await as(factoryId, () => manufacturingDashboard.inventoryValue());
    check('the store has a value', value.totalValue > 0);
    check('broken down by warehouse', value.byWarehouse.length >= 2);
    check('and by what kind of material it is', value.byMaterialType.length >= 1);
    const raw = value.byWarehouse.find((w) => w.warehouseId === ctx.rawWarehouseId);
    check('naming the warehouse type', raw?.warehouseType === 'RAW_MATERIAL');
  }

  console.log('\n=== 33. ANALYTICS ANSWER THE FIVE QUESTIONS ===');
  {
    const production = await as(factoryId, () => manufacturingAnalytics.production());
    check('production reports yield', production.yieldPercent === 90, String(production.yieldPercent));
    check('broken down by product', production.byProduct.length >= 1);
    check('and counts variance exceptions',
      production.materialVariance.linesMeasured >= 1);

    const inventory = await as(factoryId, () => manufacturingAnalytics.inventory());
    check('inventory reports what was consumed', inventory.materialsUsed >= 1);
    const sugar = inventory.usage.find((u) => u.variantId === ctx.sugarVariantId);
    check('naming the material and its value', sugar !== undefined && sugar.consumedValue > 0);
    // "800kg left" means nothing until you know whether that is a week or an
    // afternoon.
    check('and how long the stock lasts at that rate',
      sugar?.daysOfCoverRemaining !== null && sugar?.daysOfCoverRemaining !== undefined);

    const procurement = await as(factoryId, () => manufacturingAnalytics.procurement());
    check('procurement counts the orders raised', procurement.ordersRaised >= 1);
    check('and reports per supplier', procurement.bySupplier.length >= 1);
    // A draft is not outstanding — nothing has been asked for yet.
    check('a draft order is not counted as outstanding', procurement.outstandingOrders === 0,
      String(procurement.outstandingOrders));

    const quality = await as(factoryId, () => manufacturingAnalytics.quality());
    check('quality counts passed and failed', quality.inspections.passed === 1 && quality.inspections.failed === 1);
    // Out of concluded inspections only, or a backlog would flatter the rate.
    check('with a failure rate over concluded inspections only',
      quality.inspections.failureRatePercent === 50,
      String(quality.inspections.failureRatePercent));

    const maintenance = await as(factoryId, () => manufacturingAnalytics.maintenance());
    check('maintenance counts the jobs', maintenance.workOrders === 1);
    // Planned servicing is not a breakdown.
    check('separating breakdowns from planned work',
      maintenance.breakdowns === 1 && maintenance.preventive === 0);
    check('and reports availability per machine',
      maintenance.byEquipment.length === 1 &&
      maintenance.byEquipment[0]!.availabilityPercent < 100);
  }

  console.log('\n=== 34. THE ASSISTANT ANSWERS FROM THE DATABASE ===');
  {
    // The numbers must come from SQL, not from a model reading a list.
    const low = await as(factoryId, () =>
      manufacturingAi.answer('what raw materials are below reorder level?'));
    check('it recognises a stock question', low?.intent === 'materials_below_reorder');
    const dashboard = await as(factoryId, () => manufacturingDashboard.overview());
    check('and its figures are the dashboard’s own',
      JSON.stringify(low?.data) === JSON.stringify(dashboard.materials.lowStock));

    const req = await as(factoryId, () =>
      manufacturingAi.answer('how much do we need to produce 4000 cases of Demo Cola 50cl?'));
    check('it works out a requirement', req?.intent === 'requirement_for_quantity');
    const data = req?.data as { items: { variantId: string; requiredQuantity: number }[] } | null;
    const sugar = data?.items.find((i) => i.variantId === ctx.sugarVariantId);
    // 4,000 against a 1,000-case recipe needing 650kg.
    check('with the arithmetic done in the backend',
      sugar?.requiredQuantity === 2600, String(sugar?.requiredQuantity));
    check('and the answer quotes it', req!.summary.includes('2,600'));

    const efficiency = await as(factoryId, () =>
      manufacturingAi.answer('what was our production efficiency this month?'));
    check('it answers on efficiency', efficiency?.intent === 'production_efficiency');
    check('quoting the real yield', efficiency!.summary.includes('90%'));

    const quality = await as(factoryId, () => manufacturingAi.answer('show me failed QC batches'));
    check('and on quality', quality?.intent === 'quality_batches');

    const downtime = await as(factoryId, () =>
      manufacturingAi.answer('which machine has had the most downtime?'));
    check('and on downtime', downtime?.intent === 'machine_downtime');
    check('naming the machine', downtime!.summary.includes('Filler #1'));
  }

  console.log('\n=== 35. IT SAYS SO RATHER THAN GUESSING ===');
  {
    const unknown = await as(factoryId, () =>
      manufacturingAi.answer('what is the capital of France?'));
    // A confident wrong figure is worse than "I do not know that one".
    check('an unrelated question is not answered', unknown === null);

    const noProduct = await as(factoryId, () =>
      manufacturingAi.answer('how much do we need to produce 5000 units of Something Invented?'));
    check('an unknown product is not invented', noProduct?.data === null);
    check('and it says what it needs instead',
      noProduct!.summary.toLowerCase().includes('name the product'));
  }

  console.log('\n=== 36. THE ASSISTANT PROPOSES, IT NEVER ACTS ===');
  {
    const posBefore = await db.purchaseOrder.count({ where: { organizationId: factoryId } });
    const actions = await as(factoryId, () =>
      manufacturingAi.actionsForProductionOrder(ctx.plannedOrderId));
    check('it offers something to do about a shortage', actions.length >= 1);

    // §26: nothing happens without a person.
    check('every action needs confirming',
      actions.every((a) => a.requiresConfirmation === true));
    check('and names the endpoint rather than calling it',
      actions.every((a) => a.endpoint.startsWith('/api/v1/')));
    check('describing what it would do first',
      actions.every((a) => a.description.length > 20));
    const posAfter = await db.purchaseOrder.count({ where: { organizationId: factoryId } });
    check('asking for suggestions creates nothing', posAfter === posBefore);
  }

  console.log('\n=== 37. ALERTS REACH WHOEVER CAN ACT ON THEM ===');
  {
    // A membership with a role holding the permissions, so there is somebody
    // for the alerts to reach.
    const role = await db.role.create({
      data: { organizationId: factoryId, name: `Prod-${stamp}`, isSystem: false },
    });
    const perms = await db.permission.findMany({
      where: { key: { in: ['qc.release', 'qc.read', 'production.read', 'manufacturing.read'] } },
      select: { id: true },
    });
    await db.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    // The owner membership already exists (every org gets one at setup), so
    // this moves it onto the narrower role rather than creating a second.
    await db.membership.update({
      where: { organizationId_userId: { organizationId: factoryId, userId } },
      data: { roleId: role.id, isOwner: false, isActive: true },
    });

    const before = await db.notification.count({ where: { userId } });
    const sent = await manufacturingAlerts.batchFailedQc(factoryId, {
      batchNumber: 'TEST-BATCH', product: 'Demo Cola 50cl',
      reason: 'pH out of specification', batchId: ctx.batchId2,
    });
    check('the alert found a recipient', sent >= 1, String(sent));
    const after = await db.notification.count({ where: { userId } });
    check('and it landed in the ordinary tray', after > before);

    const notification = await db.notification.findFirst({
      where: { userId }, orderBy: { createdAt: 'desc' },
    });
    check('typed so it can be filtered',
      notification?.type === 'manufacturing.batch_failed_qc', String(notification?.type));
    check('and saying what happened', notification!.title.includes('TEST-BATCH'));

    // Nobody holds maintenance permissions here, so nobody is told — rather
    // than everybody being told.
    const noRecipients = await manufacturingAlerts.maintenanceDue(factoryId, {
      equipmentId: ctx.equipmentId, name: 'Filler #1',
      dueAt: new Date(), overdueDays: 3,
    });
    check('an alert nobody can act on goes to nobody', noRecipients === 0, String(noRecipients));
  }

  console.log('\n=== 38. THE SWEEP FINDS WHAT IS TRUE, NOT WHAT JUST HAPPENED ===');
  {
    // Overdue runs and due services are states; nothing fires at the instant
    // they become true, so something has to look.
    await db.productionOrder.update({
      where: { id: ctx.plannedOrderId },
      data: { status: 'IN_PROGRESS', expectedCompletionDate: new Date(Date.now() - 3 * 86_400_000) },
    });
    const result = await manufacturingAlerts.runSweep(factoryId);
    check('the sweep finds the overdue run', result.alerts.includes('production_delayed'));
    check('and reports how many people it told', result.sent >= 1, String(result.sent));
  }

  console.log('\n=== 39. A UNIT OF MEASURE SURVIVES BEING EDITED ===');
  {
    /*
     * The unit was settable and never returned, so every edit form loaded it
     * blank and wrote that blank straight back — a product's unit could be set
     * once and was then cleared by the next unrelated edit.
     */
    const product = await as(factoryId, () =>
      catalogService.createProduct({
        name: 'Bulk syrup', status: 'ACTIVE', taxRate: 0, unit: 'L',
        variants: [{ sku: `SYR-${stamp}`, price: 0, isDefault: true }],
      } as never),
    );
    check('a unit set at creation is stored',
      (product as { unit?: string }).unit === 'L', String((product as { unit?: string }).unit));

    const read = await as(factoryId, () => catalogService.getProduct(product.id));
    check('and comes back when the product is read',
      (read as { unit?: string }).unit === 'L', String((read as { unit?: string }).unit));

    const listed = await as(factoryId, () => catalogService.listProducts({ limit: 100 } as never));
    const inList = listed.items.find((p: { id: string }) => p.id === product.id);
    check('and in the list a form loads from',
      (inList as { unit?: string } | undefined)?.unit === 'L');

    // The regression: an edit that never mentions the unit must not clear it.
    await as(factoryId, () =>
      catalogService.updateProduct(product.id, { name: 'Bulk syrup (renamed)' } as never));
    const after = await as(factoryId, () => catalogService.getProduct(product.id));
    check('an unrelated edit leaves it alone',
      (after as { unit?: string }).unit === 'L', String((after as { unit?: string }).unit));

    // And it can still be changed deliberately.
    await as(factoryId, () => catalogService.updateProduct(product.id, { unit: 'kg' } as never));
    const changed = await as(factoryId, () => catalogService.getProduct(product.id));
    check('while a deliberate change still takes',
      (changed as { unit?: string }).unit === 'kg');
  }

  console.log('\n=== 40. A QUANTITY IS READ WITH ITS UNIT ===');
  {
    // "1,200" says nothing on a shelf. The stock list has to carry the unit
    // or every screen showing it has to guess.
    const stock = await as(factoryId, () => inventoryService.listStock({ limit: 50 } as never));
    const row = stock.items.find(
      (r: { variant: { id: string } }) => r.variant.id === ctx.sugarVariantId,
    ) as { variant: { product: { unit?: string | null } } } | undefined;
    check('a stock row carries the product’s unit',
      row?.variant.product.unit === 'kg', String(row?.variant.product.unit));
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** A small but complete factory: two materials, a product, and stock. */
async function buildFactory() {
  const settings = await as(factoryId, () => manufacturingSettings.get());
  void settings;

  const make = async (name: string, sku: string, opts: Record<string, unknown> = {}) => {
    const p = await as(factoryId, () =>
      catalogService.createProduct({
        name, status: 'ACTIVE', taxRate: 0, unit: (opts.unit as string) ?? 'each',
        variants: [{ sku, price: 0, costPrice: (opts.costPrice as number) ?? 0, isDefault: true }],
      } as never),
    );
    await db.product.update({ where: { id: p.id }, data: opts.product as never });
    const variant = await db.productVariant.findFirstOrThrow({ where: { productId: p.id } });
    return { productId: p.id, variantId: variant.id };
  };

  const sugar = await make('Refined sugar', `SUG-${stamp}`, {
    unit: 'kg', costPrice: 850,
    product: { manufacturingType: 'RAW_MATERIAL', sellable: false, safetyStock: 100 },
  });
  const bottle = await make('PET bottle 50cl', `PET-${stamp}`, {
    unit: 'each', costPrice: 25,
    product: { manufacturingType: 'PACKAGING', sellable: false },
  });
  const drink = await make('Demo Cola 50cl', `COLA-${stamp}`, {
    unit: 'case',
    product: { manufacturingType: 'FINISHED_GOOD', manufacturingEnabled: true, batchTracked: true },
  });

  const raw = await as(factoryId, () =>
    inventoryService.createWarehouse({ name: 'Raw materials', code: `RAW${stamp}`.slice(0, 20) } as never),
  );
  const finished = await as(factoryId, () =>
    inventoryService.createWarehouse({ name: 'Finished goods', code: `FIN${stamp}`.slice(0, 20) } as never),
  );
  await db.warehouse.update({ where: { id: raw.id }, data: { warehouseType: 'RAW_MATERIAL' } });
  await db.warehouse.update({ where: { id: finished.id }, data: { warehouseType: 'FINISHED_GOODS' } });

  // Deliberately short of sugar, so the shortage check has something true to
  // report.
  const bottleOpeningStock = 50000;
  await as(factoryId, () =>
    inventoryService.adjustStock(
      { variantId: sugar.variantId, warehouseId: raw.id, quantityChange: 1000 } as never, userId),
  );
  await as(factoryId, () =>
    inventoryService.adjustStock(
      { variantId: bottle.variantId, warehouseId: raw.id, quantityChange: bottleOpeningStock } as never, userId),
  );

  return {
    sugarProductId: sugar.productId, sugarVariantId: sugar.variantId,
    bottleVariantId: bottle.variantId, bottleOpeningStock,
    drinkId: drink.productId, drinkVariantId: drink.variantId,
    rawWarehouseId: raw.id, finishedWarehouseId: finished.id,
    bomId: '', orderId: '', batchId: '', planId: '', plannedOrderId: '',
    orderId2: '', batchId2: '', inspectionId: '',
    lineId: '', equipmentId: '', workOrderId: '',
  };
}

async function cleanup() {
  for (const orgId of [shopId, factoryId].filter(Boolean)) {
    await db.notification.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } }).catch(() => {});
    await db.membership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.maintenancePart.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.maintenanceWorkOrder.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.equipment.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionVariance.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionCost.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.quarantineRecord.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.qualityInspectionItem.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.qualityInspection.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.qualityParameter.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.stockTransferItem.deleteMany({ where: { transfer: { organizationId: orgId } } }).catch(() => {});
    await db.stockTransfer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.internalRequisitionItem.deleteMany({ where: { requisition: { organizationId: orgId } } }).catch(() => {});
    await db.internalRequisition.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { organizationId: orgId } } }).catch(() => {});
    await db.purchaseOrder.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.supplierProduct.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.supplier.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionPlan.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionLine.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionOutput.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.materialConsumption.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.batch.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionMaterial.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productionOrder.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.billOfMaterialItem.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.billOfMaterial.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.manufacturingSettings.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.stockLevel.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.stockMovement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.productVariant.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.product.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.warehouse.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organizationModule.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
  await db.user.delete({ where: { id: userId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
