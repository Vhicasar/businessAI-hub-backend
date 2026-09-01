/*
 * Internal requisition: one warehouse asks another for stock.
 *
 * The acceptance criterion that matters is §14 — the destination's count must
 * not rise because someone asked. So every stage checks both warehouses, not
 * just the paperwork.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { requisitionsService } from '../../src/application/inventory/requisitions.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '', mainWh = '', branch = '', variant = '', reqId = '', itemId = '', noteToken = '';

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

const stockAt = async (warehouseId: string) => {
  const l = await db.stockLevel.findFirst({ where: { warehouseId, variantId: variant } });
  return l ? Number(l.quantity) : 0;
};

async function main() {
  const org = await db.organization.create({
    data: { name: 'IR Co', slug: `ir-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `ir-${stamp}@t.test`, passwordHash: 'x', firstName: 'Ife', lastName: 'O' },
  });
  userId = user.id;

  mainWh = (await db.warehouse.create({
    data: { organizationId: orgId, name: 'Main Warehouse', code: `M-${stamp}`, isDefault: true },
  })).id;
  branch = (await db.warehouse.create({
    data: { organizationId: orgId, name: 'Branch Warehouse', code: `B-${stamp}` },
  })).id;

  const product = await db.product.create({
    data: { organizationId: orgId, name: 'Product A', slug: `pa-${stamp}`, type: 'PHYSICAL' as never },
  });
  variant = (await db.productVariant.create({
    data: {
      organizationId: orgId, productId: product.id, sku: `SKU-${stamp}`,
      barcode: `BC-${stamp}`, price: 100,
    },
  })).id;

  // Main holds 100, Branch holds 20 — the example from the brief.
  await db.stockLevel.create({
    data: { organizationId: orgId, warehouseId: mainWh, variantId: variant, quantity: 100 },
  });
  await db.stockLevel.create({
    data: { organizationId: orgId, warehouseId: branch, variantId: variant, quantity: 20 },
  });

  console.log('\n=== 1. A WAREHOUSE CANNOT REQUEST FROM ITSELF ===');
  await asUser(async () => {
    let msg = '';
    try {
      await requisitionsService.create({
        fromWarehouseId: mainWh, toWarehouseId: mainWh,
        items: [{ variantId: variant, requestedQty: 5 }], priority: 'NORMAL',
      } as never);
    } catch (e) { msg = (e as Error).message; }
    check('the same warehouse on both sides is refused', msg.includes('cannot request stock from itself'), msg);
  });

  console.log('\n=== 2. AVAILABILITY IS SHOWN BEFORE ASKING ===');
  await asUser(async () => {
    const avail = await requisitionsService.availability(mainWh, [variant]);
    check('the source’s available stock is reported', avail[0]?.available === 100, String(avail[0]?.available));
  });

  console.log('\n=== 3. THE REQUEST MOVES NO STOCK ===');
  await asUser(async () => {
    const created = await requisitionsService.create({
      fromWarehouseId: mainWh, toWarehouseId: branch,
      items: [{ variantId: variant, requestedQty: 30 }],
      reason: 'Branch running low before the weekend.',
      priority: 'NORMAL', submit: true,
    } as never);
    reqId = created.id;
    itemId = created.items[0]!.id;
    noteToken = created.scanToken!;

    check('a numbered requisition exists', created.number.startsWith('IR-'), created.number);
    check('it is submitted for approval', created.status === 'SUBMITTED', created.status);
    check('the source warehouse is unchanged', (await stockAt(mainWh)) === 100);
    check('and the destination has not gained anything', (await stockAt(branch)) === 20);
    check('it carries a scan token for the destination', Boolean(created.scanToken));
    check('and a scannable payload for the printed note',
      created.scanPayload === `vhicasar://ir/${created.scanToken}`, String(created.scanPayload));
  });

  console.log('\n=== 4. DISPATCH IS REFUSED BEFORE APPROVAL ===');
  await asUser(async () => {
    let msg = '';
    try { await requisitionsService.dispatch(reqId, {} as never); } catch (e) { msg = (e as Error).message; }
    check('an unapproved requisition cannot dispatch', msg.includes('not approved'), msg);
    check('so no stock left the source', (await stockAt(mainWh)) === 100);
  });

  console.log('\n=== 5. THE SOURCE CAN AGREE TO LESS THAN WAS ASKED ===');
  await asUser(async () => {
    const approved = await requisitionsService.approve(reqId, {
      items: [{ itemId, approvedQty: 20 }], note: 'Can only spare 20 this week.',
    } as never);
    check('the requisition is approved', approved.status === 'APPROVED');
    check('with the agreed quantity recorded', Number(approved.items[0]!.approvedQty) === 20);
    check('and the original request preserved', Number(approved.items[0]!.requestedQty) === 30);
    check('still nothing has moved', (await stockAt(mainWh)) === 100 && (await stockAt(branch)) === 20);

    let over = '';
    try {
      await requisitionsService.approve(reqId, { items: [{ itemId, approvedQty: 50 }] } as never);
    } catch (e) { over = (e as Error).message; }
    check('approving more than requested is refused', over.length > 0);
  });

  console.log('\n=== 6. DISPATCH TAKES STOCK OUT OF THE SOURCE ONLY ===');
  await asUser(async () => {
    await requisitionsService.dispatch(reqId, {
      items: [{ itemId, quantity: 12 }], idempotencyKey: `d1-${stamp}`,
    } as never);

    check('the source has gone down', (await stockAt(mainWh)) === 88, String(await stockAt(mainWh)));
    // The heart of §14: in transit is not yet arrived.
    check('the destination has NOT gone up', (await stockAt(branch)) === 20, String(await stockAt(branch)));

    const r = await requisitionsService.byId(reqId);
    check('the requisition reads partially dispatched', r.status === 'PARTIALLY_DISPATCHED', r.status);
    check('a transfer record was raised', r.transfers.length === 1);
    check('and it is in transit', r.transfers[0]!.status === 'IN_TRANSIT');
  });

  console.log('\n=== 7. A REPLAYED DISPATCH DOES NOT SEND TWICE ===');
  await asUser(async () => {
    const before = await stockAt(mainWh);
    await requisitionsService.dispatch(reqId, {
      items: [{ itemId, quantity: 12 }], idempotencyKey: `d1-${stamp}`,
    } as never);
    check('the source is unchanged on replay', (await stockAt(mainWh)) === before, String(await stockAt(mainWh)));
    check('and only one transfer exists',
      (await db.stockTransfer.count({ where: { requisitionId: reqId } })) === 1);
  });

  console.log('\n=== 7b. RECEIVING NEEDS THE NOTE THAT CAME WITH THE STOCK ===');
  await asUser(async () => {
    const before = await stockAt(branch);
    let noToken = '';
    try {
      await requisitionsService.receive(reqId, { items: [{ itemId, quantity: 1 }] } as never);
    } catch (e) { noToken = (e as Error).message; }
    check('receiving without the code is refused', noToken.length > 0, noToken);

    let wrongToken = '';
    try {
      await requisitionsService.receive(reqId, {
        items: [{ itemId, quantity: 1 }], scanToken: 'not-the-right-code',
      } as never);
    } catch (e) { wrongToken = (e as Error).message; }
    check('a wrong code is refused', wrongToken.includes('does not match'), wrongToken);
    check('and says where to find the right one', wrongToken.includes('requisition note'), wrongToken);
    check('so no stock appeared at the destination', (await stockAt(branch)) === before);
  });

  console.log('\n=== 8. RECEIVING RAISES THE DESTINATION ===');
  await asUser(async () => {
    const view = await requisitionsService.receivingView(reqId);
    const line = view.items[0]!;
    check('the view shows what was requested', line.requested === 30);
    check('what was approved', line.approved === 20);
    check('what is actually in transit', line.expected === 12, String(line.expected));
    check('nothing received yet', line.previouslyReceived === 0);
    check('and the remainder to receive', line.remaining === 12);
    check('with a barcode so it can be scanned in', line.barcode === `BC-${stamp}`);

    await requisitionsService.receive(reqId, {
      items: [{ itemId, quantity: 12 }], idempotencyKey: `r1-${stamp}`,
      scanToken: noteToken,
    } as never);
    check('the destination has gone up', (await stockAt(branch)) === 32, String(await stockAt(branch)));
    check('the source is unchanged by receiving', (await stockAt(mainWh)) === 88);

    const r = await requisitionsService.byId(reqId);
    check('and the requisition reads partially received', r.status === 'PARTIALLY_RECEIVED', r.status);
  });

  console.log('\n=== 9. THE REMAINDER STAYS VISIBLE ===');
  await asUser(async () => {
    const r = await requisitionsService.byId(reqId);
    const i = r.items[0]!;
    check('requested is still 30', Number(i.requestedQty) === 30);
    check('dispatched reads 12', Number(i.dispatchedQty) === 12);
    check('received reads 12', Number(i.receivedQty) === 12);
    check('so 8 of the approved 20 is still owed',
      Number(i.approvedQty) - Number(i.dispatchedQty) === 8);
  });

  console.log('\n=== 10. COMPLETING THE AGREED QUANTITY CLOSES IT ===');
  await asUser(async () => {
    await requisitionsService.dispatch(reqId, {
      items: [{ itemId, quantity: 8 }], idempotencyKey: `d2-${stamp}`,
    } as never);
    await requisitionsService.receive(reqId, {
      items: [{ itemId, quantity: 8 }], idempotencyKey: `r2-${stamp}`,
      scanToken: noteToken,
    } as never);

    const r = await requisitionsService.byId(reqId);
    check('the requisition is complete', r.status === 'COMPLETED', r.status);
    check('and dated', r.completedAt !== null);
    check('the source ends at 80', (await stockAt(mainWh)) === 80, String(await stockAt(mainWh)));
    check('the destination ends at 40', (await stockAt(branch)) === 40, String(await stockAt(branch)));
    check('nothing was created or destroyed',
      (await stockAt(mainWh)) + (await stockAt(branch)) === 120);
    check('the transfers are marked received',
      r.transfers.every((t) => t.status === 'RECEIVED'), r.transfers.map((t) => t.status).join(','));
  });

  console.log('\n=== 11. STOCK MOVEMENTS TELL THE WHOLE STORY ===');
  {
    const moves = await db.stockMovement.findMany({
      where: { organizationId: orgId, referenceId: reqId },
      orderBy: { createdAt: 'asc' },
    });
    check('there is a movement per dispatch and per receipt', moves.length === 4, String(moves.length));
    const out = moves.filter((m) => m.type === 'TRANSFER_OUT');
    const inn = moves.filter((m) => m.type === 'TRANSFER_IN');
    check('two out of the source', out.length === 2 && out.every((m) => m.warehouseId === mainWh));
    check('two into the destination', inn.length === 2 && inn.every((m) => m.warehouseId === branch));
    check('outbound is negative', out.every((m) => Number(m.quantity) < 0));
    check('inbound is positive', inn.every((m) => Number(m.quantity) > 0));
    check('and every movement names who did it', moves.every((m) => m.actorUserId === userId));
  }

  console.log('\n=== 12. AUDIT COVERS THE LIFECYCLE ===');
  {
    const entries = await db.auditLog.findMany({
      where: { organizationId: orgId, entityId: reqId },
      orderBy: { createdAt: 'asc' },
    });
    const actions = entries.map((e) => e.action);
    for (const want of ['requisition.created', 'requisition.approved', 'requisition.dispatched', 'requisition.completed']) {
      check(`${want} is recorded`, actions.includes(want), actions.join(','));
    }
    const approved = entries.find((e) => e.action === 'requisition.approved');
    check('approval records the previous status',
      (approved?.before as Record<string, unknown>)?.status === 'SUBMITTED');
  }

  console.log('\n=== 13. INSUFFICIENT STOCK IS REFUSED ===');
  await asUser(async () => {
    const big = await requisitionsService.create({
      fromWarehouseId: mainWh, toWarehouseId: branch,
      items: [{ variantId: variant, requestedQty: 500 }], priority: 'HIGH', submit: true,
    } as never);
    await requisitionsService.approve(big.id, {} as never);
    let msg = '';
    try { await requisitionsService.dispatch(big.id, {} as never); } catch (e) { msg = (e as Error).message; }
    check('dispatching more than the shelf holds is refused', msg.includes('available'), msg);
    check('and the source is untouched', (await stockAt(mainWh)) === 80);
    await requisitionsService.cancel(big.id, 'Not available');
    check('an undispatched requisition can be cancelled',
      (await requisitionsService.byId(big.id)).status === 'CANCELLED');
  });

  console.log('\n=== 14. REJECTION NEEDS A REASON, AND MOVES NOTHING ===');
  await asUser(async () => {
    const r = await requisitionsService.create({
      fromWarehouseId: mainWh, toWarehouseId: branch,
      items: [{ variantId: variant, requestedQty: 5 }], priority: 'LOW', submit: true,
    } as never);
    let noReason = '';
    try { await requisitionsService.reject(r.id, '  '); } catch (e) { noReason = (e as Error).message; }
    check('a rejection without a reason is refused', noReason.includes('reason'), noReason);

    const rejected = await requisitionsService.reject(r.id, 'Needed for a customer order here.');
    check('rejecting records the reason', rejected.rejectionReason?.includes('customer order'));
    check('and no stock moved', (await stockAt(mainWh)) === 80 && (await stockAt(branch)) === 40);
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.stockTransferItem.deleteMany({ where: { transfer: { organizationId: orgId } } }).catch(() => {});
  await db.stockTransfer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.internalRequisitionItem.deleteMany({ where: { requisition: { organizationId: orgId } } }).catch(() => {});
  await db.internalRequisition.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockMovement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockLevel.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.productVariant.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.product.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.warehouse.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.notification.deleteMany({ where: { userId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
