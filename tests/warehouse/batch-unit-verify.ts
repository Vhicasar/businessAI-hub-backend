/*
 * Unit of measure, and batch/lot/expiry captured where stock arrives.
 *
 * The batch record is deliberately a record of what *arrived* — sales and
 * transfers do not pick batches, so anything claiming to be remaining stock
 * would drift. These assertions hold it to that promise.
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
let orgId = '', userId = '', wh = '', variantId = '', poId = '', itemId = '';
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

async function main() {
  const org = await db.organization.create({
    data: { name: 'Batch Co', slug: `batch-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  userId = (await db.user.create({
    data: { email: `b-${stamp}@t.test`, passwordHash: 'x', firstName: 'Bola', lastName: 'A' },
  })).id;
  wh = (await db.warehouse.create({
    data: { organizationId: orgId, name: 'Main', code: `MB-${stamp}`, isDefault: true },
  })).id;

  const supplier = await db.supplier.create({ data: { organizationId: orgId, name: 'Dairy Co' } });
  const product = await db.product.create({
    data: {
      organizationId: orgId, name: 'Milk 1L', slug: `milk-${stamp}`,
      type: 'PHYSICAL' as never,
      // The unit of measure the brief asked for.
      unit: 'carton',
    },
  });
  variantId = (await db.productVariant.create({
    data: { organizationId: orgId, productId: product.id, sku: `MILK-${stamp}`, barcode: `BCM-${stamp}`, price: 500 },
  })).id;

  const po = await db.purchaseOrder.create({
    data: {
      organizationId: orgId, number: `PO-B-${stamp}`, supplierId: supplier.id, warehouseId: wh,
      status: 'ORDERED', currency: 'NGN', subtotal: 0, taxTotal: 0, total: 0,
      items: { create: [{ variantId, quantity: 100, unitCost: 400, total: 40000 }] },
    },
    include: { items: true },
  });
  poId = po.id;
  itemId = po.items[0]!.id;

  console.log('\n=== 1. THE UNIT OF MEASURE REACHES THE WAREHOUSE ===');
  await asUser(async () => {
    const view = await purchaseOrdersService.receivingView(poId);
    check('the line carries its unit', view.items[0]!.unit === 'carton', String(view.items[0]!.unit));
    check('alongside the quantities it qualifies', view.items[0]!.expected === 100);
  });

  console.log('\n=== 2. BATCH AND EXPIRY ARE CAPTURED AT RECEIPT ===');
  await asUser(async () => {
    await purchaseOrdersService.receive(poId, {
      items: [{ itemId, quantity: 40, batchNumber: 'LOT-A', expiryDate: inDays(5) }],
      idempotencyKey: `b1-${stamp}`,
    } as never, userId);

    const line = await db.purchaseOrderReceiptLine.findFirstOrThrow({
      where: { receipt: { purchaseOrderId: poId } },
    });
    check('the receipt line records the batch', line.batchNumber === 'LOT-A');
    check('and the expiry', line.expiryDate !== null);

    const move = await db.stockMovement.findFirstOrThrow({
      where: { organizationId: orgId, referenceId: poId },
      orderBy: { createdAt: 'desc' },
    });
    // Carried on the movement so traceability survives the receipt being
    // archived.
    check('the stock movement carries the batch too', move.batchNumber === 'LOT-A');
    check('and its expiry', move.expiryDate !== null);
  });

  console.log('\n=== 3. TWO DELIVERIES, TWO BATCHES, ONE ORDER LINE ===');
  await asUser(async () => {
    await purchaseOrdersService.receive(poId, {
      items: [{ itemId, quantity: 60, batchNumber: 'LOT-B', expiryDate: inDays(200) }],
      idempotencyKey: `b2-${stamp}`,
    } as never, userId);

    const lines = await db.purchaseOrderReceiptLine.findMany({
      where: { receipt: { purchaseOrderId: poId } },
    });
    check('both batches are kept separately', lines.length === 2, String(lines.length));
    check('with different references',
      new Set(lines.map((l) => l.batchNumber)).size === 2);
    check('the order is fully received',
      (await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status === 'RECEIVED');
  });

  console.log('\n=== 4. RECEIVING WITHOUT BATCH INFO STILL WORKS ===');
  await asUser(async () => {
    const po2 = await db.purchaseOrder.create({
      data: {
        organizationId: orgId, number: `PO-B2-${stamp}`, supplierId: supplier.id, warehouseId: wh,
        status: 'ORDERED', currency: 'NGN', subtotal: 0, taxTotal: 0, total: 0,
        items: { create: [{ variantId, quantity: 5, unitCost: 400, total: 2000 }] },
      },
      include: { items: true },
    });
    // No batch fields at all — the common case for goods that do not expire.
    await purchaseOrdersService.receive(po2.id, { idempotencyKey: `b3-${stamp}` } as never, userId);
    const line = await db.purchaseOrderReceiptLine.findFirstOrThrow({
      where: { receipt: { purchaseOrderId: po2.id } },
    });
    check('the line is recorded with no batch', line.batchNumber === null);
    check('and no expiry', line.expiryDate === null);
    check('stock still moved',
      Number((await db.stockLevel.findFirstOrThrow({ where: { warehouseId: wh, variantId } })).quantity) === 105);
  });

  console.log('\n=== 5. EXPIRING BATCHES CAN BE FOUND ===');
  await asUser(async () => {
    const all = await inventoryService.listBatches({ warehouseId: wh });
    check('only batched receipts are listed', all.length === 2, String(all.length));
    check('soonest to expire first', all[0]!.batchNumber === 'LOT-A', String(all[0]!.batchNumber));
    check('with days remaining', (all[0]!.daysToExpiry ?? 0) <= 5 && (all[0]!.daysToExpiry ?? 0) > 0,
      String(all[0]!.daysToExpiry));
    check('the unit travels with it', all[0]!.unit === 'carton');
    check('and the quantity that arrived', all[0]!.quantityReceived === 40);
    check('naming where it landed', all[0]!.warehouse.id === wh);

    const soon = await inventoryService.listBatches({ warehouseId: wh, expiringWithinDays: 30 });
    check('a window filters out the long-dated batch', soon.length === 1, String(soon.length));
    check('keeping the one about to expire', soon[0]!.batchNumber === 'LOT-A');
  });

  console.log('\n=== 6. AN EXPIRED BATCH READS AS EXPIRED ===');
  await asUser(async () => {
    const po3 = await db.purchaseOrder.create({
      data: {
        organizationId: orgId, number: `PO-B3-${stamp}`, supplierId: supplier.id, warehouseId: wh,
        status: 'ORDERED', currency: 'NGN', subtotal: 0, taxTotal: 0, total: 0,
        items: { create: [{ variantId, quantity: 3, unitCost: 400, total: 1200 }] },
      },
      include: { items: true },
    });
    await purchaseOrdersService.receive(po3.id, {
      items: [{ itemId: po3.items[0]!.id, quantity: 3, batchNumber: 'LOT-OLD', expiryDate: inDays(-2) }],
      idempotencyKey: `b4-${stamp}`,
    } as never, userId);

    const all = await inventoryService.listBatches({ warehouseId: wh });
    const old = all.find((b) => b.batchNumber === 'LOT-OLD')!;
    check('it is flagged expired', old.expired === true);
    check('with a negative countdown, not zero', (old.daysToExpiry ?? 0) < 0, String(old.daysToExpiry));
    check('and it sorts to the front', all[0]!.batchNumber === 'LOT-OLD');
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
