/*
 * Running an order once it has started, and closing a maintenance job.
 *
 * Four things reported as missing or lost, all verified end to end here:
 * material issued to a live run, downtime that survives being recorded, a QC
 * inspection that has something to record against, and the split between
 * requisitioning material that exists and buying material that does not.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { materialConsumptionService } from '../../src/application/manufacturing/material-consumption.service';
import { equipmentService } from '../../src/application/manufacturing/equipment.service';
import { qualityControlService } from '../../src/application/manufacturing/quality-control.service';
import { procurementRecommendationsService } from '../../src/application/manufacturing/procurement-recommendations.service';
import { productionOrdersService } from '../../src/application/manufacturing/production-orders.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '', store = '', otherStore = '', finished = '';
let productId = '', variantId = '', matProduct = '', matVariant = '';
let scarceProduct = '', scarceVariant = '', bomId = '', orderId = '', equipmentId = '';

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

async function main() {
  const org = await db.organization.create({
    data: { name: 'Run Co', slug: `run-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  userId = (await db.user.create({
    data: { email: `run-${stamp}@t.test`, passwordHash: 'x', firstName: 'Run', lastName: 'T' },
  })).id;

  const mkWh = async (name: string, code: string, isDefault = false) =>
    (await db.warehouse.create({
      data: { organizationId: orgId, name, code: `${code}-${stamp}`, isDefault },
    })).id;
  store = await mkWh('Main store', 'MS', true);
  otherStore = await mkWh('Second store', 'SS');
  finished = await mkWh('Finished goods', 'FG');

  const mkProduct = async (name: string, unit: string) =>
    db.product.create({
      data: { organizationId: orgId, name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${stamp}`, type: 'PHYSICAL' as never, unit },
    });
  const mkVariant = async (productId: string, sku: string) =>
    (await db.productVariant.create({
      data: { organizationId: orgId, productId, sku: `${sku}-${stamp}`, price: 100 },
    })).id;

  productId = (await mkProduct('Widget', 'case')).id;
  variantId = await mkVariant(productId, 'WID');
  matProduct = (await mkProduct('Steel', 'kg')).id;
  matVariant = await mkVariant(matProduct, 'STL');
  scarceProduct = (await mkProduct('Rare Resin', 'kg')).id;
  scarceVariant = await mkVariant(scarceProduct, 'RSN');

  // Plenty of steel in the MAIN store; the resin exists only in the second one.
  await db.stockLevel.create({
    data: { organizationId: orgId, warehouseId: store, variantId: matVariant, quantity: 1000 },
  });
  await db.stockLevel.create({
    data: { organizationId: orgId, warehouseId: otherStore, variantId: scarceVariant, quantity: 400 },
  });

  bomId = (await db.billOfMaterial.create({
    data: {
      organizationId: orgId, productId, bomNumber: `BOM-${stamp}`, version: 1,
      status: 'ACTIVE', outputQuantity: 100, warehouseId: store,
      items: {
        create: [
          { organizationId: orgId, variantId: matVariant, quantity: 2, scrapPercent: 0 },
          { organizationId: orgId, variantId: scarceVariant, quantity: 3, scrapPercent: 0 },
        ],
      },
    },
  })).id;

  // Created through the service so the order's materials are exploded from the
  // recipe — issuing checks against those, not against the BOM directly.
  orderId = await as(async () => {
    const created = await productionOrdersService.create({
      productId, bomId, plannedQuantity: 100,
      warehouseId: store, finishedWarehouseId: finished,
    } as never);
    await db.productionOrder.update({
      where: { id: created.id },
      data: { status: 'IN_PROGRESS', startDate: new Date() },
    });
    return created.id;
  });

  // ── 1. Material can be issued to a live run ──────────────────────────────
  console.log('\nMaterial can be issued to a run that has started');
  await as(async () => {
    const before = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: store, variantId: matVariant },
    });
    await materialConsumptionService.issue(
      orderId, { warehouseId: store, items: [{ variantId: matVariant, quantity: 150 }] } as never, userId,
    );
    const after = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: store, variantId: matVariant },
    });
    check('stock leaves the store', Number(before.quantity) - Number(after.quantity) === 150);

    const history = await materialConsumptionService.history(orderId);
    check('the run now has a material history', history.length > 0);
    check('and it records what was issued',
      history.some((h) => Number(h.issuedQuantity) === 150));

    // Consuming what was issued, and handing back the rest.
    await materialConsumptionService.consume(
      orderId, { items: [{ variantId: matVariant, quantity: 120 }] } as never, userId,
    );
    const used = await materialConsumptionService.history(orderId);
    const consumed = used.reduce((sum, h) => sum + Number(h.consumedQuantity ?? 0), 0);
    check('consumption is recorded against the run', consumed === 120);

    await materialConsumptionService.returnToStore(
      orderId, { warehouseId: store, items: [{ variantId: matVariant, quantity: 30 }] } as never, userId,
    );
    const back = await db.stockLevel.findFirstOrThrow({
      where: { warehouseId: store, variantId: matVariant },
    });
    check('what was not used goes back to the store',
      Number(back.quantity) === Number(after.quantity) + 30);
  });

  // ── 2. Shortages split into "move it" and "buy it" ───────────────────────
  console.log('\nA shortage is answered by moving stock or buying it, not always buying');
  await as(async () => {
    const rec = await procurementRecommendationsService.forProductionOrder(orderId);
    const resin = rec.recommendations.find((r) => r.variantId === scarceVariant);
    check('the resin is short in the order warehouse', Boolean(resin));
    check('and the answer is to move it, not buy it', resin?.recommendedAction === 'TRANSFER');
    check('naming the store that has it',
      resin?.availableElsewhere[0]?.warehouse.id === otherStore);
    check('with enough to cover the shortfall',
      (resin?.availableElsewhere[0]?.available ?? 0) >= (resin?.shortfallQuantity ?? Infinity));
  });

  console.log('\nThe run\u2019s own store is never offered as the source');
  await as(async () => {
    // Some resin in the order's own store, but not enough — the case that
    // used to list that store as a transfer source and produce a requisition
    // the server then refused as "a warehouse cannot requisition from itself".
    await db.stockLevel.create({
      // Deliberately less than the run needs: enough to make the store look
      // like a source, not enough to be one.
      data: { organizationId: orgId, warehouseId: store, variantId: scarceVariant, quantity: 1 },
    });
    const rec = await procurementRecommendationsService.forProductionOrder(orderId);
    const resin = rec.recommendations.find((r) => r.variantId === scarceVariant);
    check('it is still short', (resin?.shortfallQuantity ?? 0) > 0);
    check('and its own store is not offered as a source',
      !(resin?.availableElsewhere ?? []).some((e) => e.warehouse.id === store));
    check('the other store still is',
      (resin?.availableElsewhere ?? []).some((e) => e.warehouse.id === otherStore));
  });

  console.log('\nAnd the requisition it raises asks the right store');
  await as(async () => {
    const req = await procurementRecommendationsService.requestFromWarehouse(
      orderId,
      { fromWarehouseId: otherStore, variantIds: [scarceVariant], submit: true } as never,
    );
    const created = await db.internalRequisition.findFirstOrThrow({
      where: { id: (req as { id: string }).id },
      select: { fromWarehouseId: true, toWarehouseId: true, items: { select: { variantId: true } } },
    });
    check('it is asked of the store that holds the stock', created.fromWarehouseId === otherStore);
    check('and delivered to the order warehouse', created.toWarehouseId === store);
    check('for the material that was short',
      created.items.length === 1 && created.items[0]!.variantId === scarceVariant);
  });

  // ── 3. Downtime survives being recorded ──────────────────────────────────
  console.log('\nDowntime recorded on a work order is still there afterwards');
  await as(async () => {
    equipmentId = (await equipmentService.create({
      name: 'Press A', code: `EQ-${stamp}`, status: 'OPERATIONAL',
    } as never)).id;
    const wo = await equipmentService.createWorkOrder({
      equipmentId, type: 'CORRECTIVE', priority: 'HIGH', issue: 'Belt slipping',
    } as never);
    await equipmentService.startWorkOrder(wo.id);

    // 1.5 hours, the case the old prompt turned into nothing.
    await equipmentService.completeWorkOrder(wo.id, { downtimeMinutes: 90 } as never, userId);
    const after = await equipmentService.getWorkOrder(wo.id);
    check('the figure is stored', after.downtimeMinutes === 90);
    check('and the job reads as completed', after.status === 'COMPLETED');

    const listed = await equipmentService.listWorkOrders({});
    const found = listed.find((w) => w.id === wo.id);
    check('a completed job still appears in the list', Boolean(found));
    check('carrying its downtime', found?.downtimeMinutes === 90);

    // Zero is a real answer — a swap-out that stopped nothing.
    const wo2 = await equipmentService.createWorkOrder({
      equipmentId, type: 'PREVENTIVE', priority: 'LOW', issue: 'Routine service',
    } as never);
    await equipmentService.startWorkOrder(wo2.id);
    await equipmentService.completeWorkOrder(wo2.id, { downtimeMinutes: 0 } as never, userId);
    const zero = await equipmentService.getWorkOrder(wo2.id);
    check('zero downtime is kept, not discarded as "not recorded"', zero.downtimeMinutes === 0);
  });

  // ── 4. An inspection has something to record against ─────────────────────
  console.log('\nAn inspection opens with the checks its product is judged on');
  await as(async () => {
    const empty = await qualityControlService.create({ variantId } as never, userId);
    check('a product with no checks opens an inspection with none',
      empty.items.length === 0);

    await qualityControlService.createParameter({
      productId, name: 'Fill volume', unit: 'ml', expectedMin: 495, expectedMax: 505,
    } as never);
    await qualityControlService.createParameter({
      productId, name: 'Cap torque', unit: 'Nm', expectedMin: 1, expectedMax: 2,
    } as never);

    const ready = await qualityControlService.create({ variantId } as never, userId);
    check('once checks exist the inspection carries them', ready.items.length === 2);
    check('each with its expected range',
      ready.items.every((i) => i.expectedMin !== null && i.expectedMax !== null));

    const target = ready.items.find((i) => i.name === 'Fill volume')!;
    await qualityControlService.recordResults(ready.id, {
      items: [{ itemId: target.id, actualNumeric: 500, actualValue: '500' }],
    } as never);
    const withResult = await qualityControlService.get(ready.id);
    const scored = withResult.items.find((i) => i.id === target.id);
    check('a reading inside the range passes', scored?.passed === true);

    await qualityControlService.recordResults(ready.id, {
      items: [{ itemId: target.id, actualNumeric: 480, actualValue: '480' }],
    } as never);
    const failed = await qualityControlService.get(ready.id);
    check('and one outside it does not',
      failed.items.find((i) => i.id === target.id)?.passed === false);
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  const org = { organizationId: orgId };
  await db.qualityInspectionItem.deleteMany({ where: { inspection: org } }).catch(() => {});
  await db.qualityInspection.deleteMany({ where: org }).catch(() => {});
  await db.qualityParameter.deleteMany({ where: org }).catch(() => {});
  await db.maintenancePart.deleteMany({ where: org }).catch(() => {});
  await db.maintenanceWorkOrder.deleteMany({ where: org }).catch(() => {});
  await db.equipment.deleteMany({ where: org }).catch(() => {});
  await db.internalRequisitionItem.deleteMany({ where: { requisition: org } }).catch(() => {});
  await db.internalRequisition.deleteMany({ where: org }).catch(() => {});
  await db.materialConsumption.deleteMany({ where: org }).catch(() => {});
  await db.productionOutput.deleteMany({ where: org }).catch(() => {});
  await db.productionOrder.deleteMany({ where: org }).catch(() => {});
  await db.billOfMaterialItem.deleteMany({ where: { bom: org } }).catch(() => {});
  await db.billOfMaterial.deleteMany({ where: org }).catch(() => {});
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
