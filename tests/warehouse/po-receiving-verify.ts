/*
 * Purchase order receiving from the warehouse floor.
 *
 * Kept in the repo rather than a scratch directory — these have been lost to
 * temp cleanup twice, and the acceptance criteria for stock movement are worth
 * being able to re-run.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { purchaseOrdersService } from '../../src/application/purchasing/purchase-orders.service';
import { inventoryService } from '../../src/application/inventory/inventory.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '', whMain = '', whBranch = '', poId = '';
let itemRice = '', itemSugar = '', variantRice = '', variantSugar = '';

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

const stockAt = async (warehouseId: string, variantId: string) => {
  const level = await db.stockLevel.findFirst({ where: { warehouseId, variantId } });
  return level ? Number(level.quantity) : 0;
};

async function main() {
  const org = await db.organization.create({
    data: { name: 'Wh Co', slug: `wh-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `wh-${stamp}@t.test`, passwordHash: 'x', firstName: 'Wale', lastName: 'K' },
  });
  userId = user.id;

  whMain = (await db.warehouse.create({
    data: { organizationId: orgId, name: 'Main Warehouse', code: `MAIN-${stamp}`, isDefault: true },
  })).id;
  whBranch = (await db.warehouse.create({
    data: { organizationId: orgId, name: 'Branch Warehouse', code: `BR-${stamp}` },
  })).id;

  const supplier = await db.supplier.create({ data: { organizationId: orgId, name: 'Acme Foods' } });
  const mkVariant = async (name: string, sku: string, barcode: string) => {
    const product = await db.product.create({
      data: { organizationId: orgId, name, slug: sku.toLowerCase(), type: 'PHYSICAL' as never },
    });
    const variant = await db.productVariant.create({
      data: { organizationId: orgId, productId: product.id, sku, barcode, price: 1000 },
    });
    return variant.id;
  };
  variantRice = await mkVariant('Rice 25kg', `RICE-${stamp}`, `BC-RICE-${stamp}`);
  variantSugar = await mkVariant('Sugar 10kg', `SUGAR-${stamp}`, `BC-SUGAR-${stamp}`);

  const po = await db.purchaseOrder.create({
    data: {
      organizationId: orgId, number: `PO-${stamp}`, supplierId: supplier.id, warehouseId: whMain,
      status: 'ORDERED', currency: 'NGN', subtotal: 0, taxTotal: 0, total: 0,
      scanToken: `tok-${stamp}`,
      items: {
        create: [
          { variantId: variantRice, quantity: 100, unitCost: 500, total: 50000 },
          { variantId: variantSugar, quantity: 20, unitCost: 300, total: 6000 },
        ],
      },
    },
    include: { items: true },
  });
  poId = po.id;
  itemRice = po.items.find((i) => i.variantId === variantRice)!.id;
  itemSugar = po.items.find((i) => i.variantId === variantSugar)!.id;

  console.log('\n=== 1. THE RECEIVING VIEW SHOWS EXPECTED VS RECEIVED ===');
  await asUser(async () => {
    const view = await purchaseOrdersService.receivingView(poId);
    check('the order is identified', view.number === `PO-${stamp}`);
    check('the supplier is auto-populated', view.supplier.name === 'Acme Foods');
    check('and the destination warehouse', view.warehouse.name === 'Main Warehouse');
    const rice = view.items.find((i) => i.itemId === itemRice)!;
    check('expected quantity is shown', rice.expected === 100);
    check('previously received is shown', rice.previouslyReceived === 0);
    check('remaining is shown', rice.remaining === 100);
    check('the barcode is included so scanning can match a line', rice.barcode === `BC-RICE-${stamp}`);
    check('as is the SKU', rice.sku === `RICE-${stamp}`);
    check('alternative warehouses are offered', view.warehouses.length === 2, String(view.warehouses.length));
    check('over-receiving is off by default', view.allowOverReceive === false);
  });

  console.log('\n=== 2. PARTIAL RECEIVING ===');
  await asUser(async () => {
    const before = await stockAt(whMain, variantRice);
    await purchaseOrdersService.receive(poId, {
      items: [{ itemId: itemRice, quantity: 40 }],
      idempotencyKey: `k1-${stamp}`,
    } as never, userId);

    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    check('the order is partially received', after.status === 'PARTIALLY_RECEIVED', after.status);
    check('stock increased by exactly what arrived',
      (await stockAt(whMain, variantRice)) === before + 40);
    check('it is not marked fully received', after.receivedAt === null);

    const view = await purchaseOrdersService.receivingView(poId);
    const rice = view.items.find((i) => i.itemId === itemRice)!;
    check('previously received now reads 40', rice.previouslyReceived === 40);
    check('and remaining reads 60', rice.remaining === 60);
  });

  console.log('\n=== 3. A REPLAYED REQUEST DOES NOT DOUBLE-RECEIVE ===');
  await asUser(async () => {
    const stockBefore = await stockAt(whMain, variantRice);
    // The same key: a double tap, an offline replay, an HTTP retry.
    await purchaseOrdersService.receive(poId, {
      items: [{ itemId: itemRice, quantity: 40 }],
      idempotencyKey: `k1-${stamp}`,
    } as never, userId);
    check('stock is unchanged on replay', (await stockAt(whMain, variantRice)) === stockBefore,
      `${stockBefore} → ${await stockAt(whMain, variantRice)}`);
    const item = await db.purchaseOrderItem.findUniqueOrThrow({ where: { id: itemRice } });
    check('and the received quantity is unchanged', Number(item.receivedQty) === 40);
    check('only one receipt exists',
      (await db.purchaseOrderReceipt.count({ where: { purchaseOrderId: poId } })) === 1);
  });

  console.log('\n=== 4. OVER-RECEIVING IS REFUSED BY DEFAULT ===');
  await asUser(async () => {
    let msg = '';
    try {
      await purchaseOrdersService.receive(poId, {
        items: [{ itemId: itemRice, quantity: 100 }],
        idempotencyKey: `k2-${stamp}`,
      } as never, userId);
    } catch (e) { msg = (e as Error).message; }
    check('receiving more than outstanding is blocked', msg.includes('only 60'), msg);
    check('and the setting to change it is named', msg.includes('over-receiving'), msg);
    check('nothing was written', (await db.purchaseOrderReceipt.count({ where: { purchaseOrderId: poId } })) === 1);
  });

  console.log('\n=== 5. WITH THE POLICY ON, IT NEEDS CONFIRMATION AND A REASON ===');
  await asUser(async () => {
    await db.organization.update({
      where: { id: orgId },
      data: { settings: { receiving: { allowOverReceive: true } } },
    });

    let noConfirm = '';
    try {
      await purchaseOrdersService.receive(poId, {
        items: [{ itemId: itemRice, quantity: 70 }], idempotencyKey: `k3-${stamp}`,
      } as never, userId);
    } catch (e) { noConfirm = (e as Error).message; }
    check('an unconfirmed over-receipt is refused', noConfirm.includes('Confirm the over-receipt'), noConfirm);

    let noReason = '';
    try {
      await purchaseOrdersService.receive(poId, {
        items: [{ itemId: itemRice, quantity: 70 }], allowOverReceive: true,
        idempotencyKey: `k4-${stamp}`,
      } as never, userId);
    } catch (e) { noReason = (e as Error).message; }
    check('and one without a reason is refused', noReason.includes('reason'), noReason);
  });

  console.log('\n=== 6. RECEIVING THE REST CLOSES THE ORDER ===');
  await asUser(async () => {
    await purchaseOrdersService.receive(poId, {
      items: [{ itemId: itemRice, quantity: 60 }, { itemId: itemSugar, quantity: 20 }],
      idempotencyKey: `k5-${stamp}`,
    } as never, userId);

    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    check('the order is fully received', after.status === 'RECEIVED', after.status);
    check('and dated', after.receivedAt !== null);
    check('rice stock totals the full order', (await stockAt(whMain, variantRice)) === 100);
    check('sugar stock too', (await stockAt(whMain, variantSugar)) === 20);
  });

  console.log('\n=== 7. EVERY MOVEMENT IS AUDITABLE ===');
  {
    const moves = await db.stockMovement.findMany({
      where: { organizationId: orgId, referenceId: poId },
      orderBy: { createdAt: 'asc' },
    });
    check('a movement exists per received line', moves.length === 3, String(moves.length));
    check('typed as a purchase receipt', moves.every((m) => m.type === 'PURCHASE_RECEIPT'));
    check('referencing the purchase order', moves.every((m) => m.referenceType === 'PURCHASE_ORDER'));
    check('naming the warehouse', moves.every((m) => m.warehouseId === whMain));
    check('and the person who received it', moves.every((m) => m.actorUserId === userId));

    const receipts = await db.purchaseOrderReceipt.findMany({
      where: { purchaseOrderId: poId }, include: { lines: true },
    });
    check('receiving history is kept per delivery', receipts.length === 2, String(receipts.length));
    check('with the outstanding quantity at the time',
      receipts.every((r) => r.lines.every((l) => Number(l.outstandingAtReceipt) > 0)));
  }

  console.log('\n=== 8. A DELIVERY CAN BE REDIRECTED TO ANOTHER WAREHOUSE ===');
  await asUser(async () => {
    const po2 = await db.purchaseOrder.create({
      data: {
        organizationId: orgId, number: `PO-${stamp}-B`, supplierId: supplier.id, warehouseId: whMain,
        status: 'ORDERED', currency: 'NGN', subtotal: 0, taxTotal: 0, total: 0,
        items: { create: [{ variantId: variantRice, quantity: 10, unitCost: 500, total: 5000 }] },
      },
      include: { items: true },
    });
    const before = await stockAt(whBranch, variantRice);
    await purchaseOrdersService.receive(po2.id, {
      items: [{ itemId: po2.items[0]!.id, quantity: 10 }],
      warehouseId: whBranch,
      idempotencyKey: `k6-${stamp}`,
    } as never, userId);
    check('stock lands in the warehouse that received it',
      (await stockAt(whBranch, variantRice)) === before + 10);
    check('and the receipt records which warehouse',
      (await db.purchaseOrderReceipt.findFirstOrThrow({
        where: { purchaseOrderId: po2.id },
      })).warehouseId === whBranch);
  });

  console.log('\n=== 9. UNIT, BATCH AND EXPIRY ===');
  await asUser(async () => {
    // A unit set on the product should reach the warehouse screen.
    await db.product.updateMany({ where: { organizationId: orgId }, data: { unit: 'bag' } });

    const po3 = await db.purchaseOrder.create({
      data: {
        organizationId: orgId, number: `PO-${stamp}-C`, supplierId: (await db.supplier.findFirstOrThrow({ where: { organizationId: orgId } })).id,
        warehouseId: whMain, status: 'ORDERED', currency: 'NGN', subtotal: 0, taxTotal: 0, total: 0,
        items: { create: [{ variantId: variantRice, quantity: 30, unitCost: 500, total: 15000 }] },
      },
      include: { items: true },
    });
    const line = po3.items[0]!;

    const view = await purchaseOrdersService.receivingView(po3.id);
    check('the unit of measure reaches the receiving screen',
      view.items[0]?.unit === 'bag', String(view.items[0]?.unit));

    const expiry = new Date(Date.now() + 90 * 86_400_000);
    await purchaseOrdersService.receive(po3.id, {
      items: [{ itemId: line.id, quantity: 30, batchNumber: 'LOT-2026-14', expiryDate: expiry }],
      idempotencyKey: `k7-${stamp}`,
    } as never, userId);

    const receiptLine = await db.purchaseOrderReceiptLine.findFirstOrThrow({
      where: { receipt: { purchaseOrderId: po3.id } },
    });
    check('the batch is recorded on the receipt', receiptLine.batchNumber === 'LOT-2026-14');
    check('and its expiry', receiptLine.expiryDate?.toDateString() === expiry.toDateString());

    const movement = await db.stockMovement.findFirstOrThrow({
      where: { organizationId: orgId, referenceId: po3.id },
    });
    check('the movement carries the batch too', movement.batchNumber === 'LOT-2026-14');
    check('so traceability survives the receipt being archived',
      movement.expiryDate?.toDateString() === expiry.toDateString());

    const history = await purchaseOrdersService.receivingView(po3.id);
    check('and the receiving history shows it',
      history.history[0]?.lines[0]?.batchNumber === 'LOT-2026-14');
  });

  console.log('\n=== 10. BATCHES CAN BE FOUND BEFORE THEY EXPIRE ===');
  await asUser(async () => {
    const batches = await inventoryService.listBatches({ warehouseId: whMain, expiringWithinDays: 120 });
    const mine = batches.find((b) => b.batchNumber === 'LOT-2026-14');
    check('the batch is listed', mine !== undefined);
    check('with days remaining', (mine?.daysToExpiry ?? 0) > 80, String(mine?.daysToExpiry));
    check('not flagged as expired', mine?.expired === false);
    check('naming the warehouse it is in', mine?.warehouse.name === 'Main Warehouse');
    check('and the unit it is counted in', mine?.unit === 'bag');

    // A window that excludes it must not return it.
    const soon = await inventoryService.listBatches({ warehouseId: whMain, expiringWithinDays: 7 });
    check('a nearer window excludes it',
      !soon.some((b) => b.batchNumber === 'LOT-2026-14'), String(soon.length));
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.purchaseOrderReceiptLine.deleteMany({ where: { receipt: { organizationId: orgId } } }).catch(() => {});
  await db.purchaseOrderReceipt.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockMovement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockLevel.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { organizationId: orgId } } }).catch(() => {});
  await db.purchaseOrder.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.supplier.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.productVariant.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.product.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.warehouse.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
