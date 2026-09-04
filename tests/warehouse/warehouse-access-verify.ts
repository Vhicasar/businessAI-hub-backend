/*
 * Per-member warehouse scoping and pre-expiry alerts.
 *
 * Two promises are under test. First, that giving someone "warehouse manager"
 * over two sites confines them to those two — reads and writes alike — while
 * everyone who was never assigned keeps the unrestricted access they have
 * today. Second, that stock is flagged before it expires, to the people who
 * can actually do something about it.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { inventoryService } from '../../src/application/inventory/inventory.service';
import {
  listAssignments,
  setAssignments,
  warehouseScope,
} from '../../src/application/inventory/warehouse-access';
import { findExpiring, runExpirySweep } from '../../src/application/inventory/expiry-alerts.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgId = '', ownerUserId = '', ownerMem = '', staffUserId = '', staffMem = '';
let whA = '', whB = '', whC = '', variantId = '', productId = '', roleId = '';

/** Act as the confined member. */
const asStaff = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run(
    { organizationId: orgId, userId: staffUserId, membershipId: staffMem } as never,
    fn
  );
/** Act as the owner. */
const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run(
    { organizationId: orgId, userId: ownerUserId, membershipId: ownerMem } as never,
    fn
  );

async function main() {
  const org = await db.organization.create({
    data: { name: 'Scope Co', slug: `scope-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  roleId = (await db.role.create({
    data: { organizationId: orgId, name: 'Warehouse Manager', isSystem: false },
  })).id;

  ownerUserId = (await db.user.create({
    data: { email: `own-${stamp}@t.test`, passwordHash: 'x', firstName: 'Ada', lastName: 'O' },
  })).id;
  staffUserId = (await db.user.create({
    data: { email: `st-${stamp}@t.test`, passwordHash: 'x', firstName: 'Chidi', lastName: 'M' },
  })).id;
  ownerMem = (await db.membership.create({
    data: { organizationId: orgId, userId: ownerUserId, roleId, isOwner: true },
  })).id;
  staffMem = (await db.membership.create({
    data: { organizationId: orgId, userId: staffUserId, roleId, isOwner: false },
  })).id;

  const mk = async (name: string, code: string, isDefault = false) =>
    (await db.warehouse.create({
      data: { organizationId: orgId, name, code: `${code}-${stamp}`, isDefault },
    })).id;
  whA = await mk('Lagos', 'LAG', true);
  whB = await mk('Abuja', 'ABJ');
  whC = await mk('Kano', 'KAN');

  const product = await db.product.create({
    data: {
      organizationId: orgId, name: 'Vaccine', slug: `vax-${stamp}`, type: 'PHYSICAL' as never,
      unit: 'vial', expiryTracked: true, batchTracked: true, expiryAlertDays: 14,
    },
  });
  productId = product.id;
  variantId = (await db.productVariant.create({
    data: { organizationId: orgId, productId, sku: `VAX-${stamp}`, price: 1000 },
  })).id;

  // ── 1. Unassigned members are unrestricted ───────────────────────────────
  console.log('\nUnassigned members keep the access they have today');
  await asStaff(async () => {
    const scope = await warehouseScope();
    check('scope is unrestricted with no assignments', scope.readable === null);
    const list = await inventoryService.listWarehouses();
    check('sees every warehouse', list.length === 3, `saw ${list.length}`);
  });

  // ── 2. Assignment confines them ──────────────────────────────────────────
  console.log('\nAssigning warehouses narrows what the member can see');
  await asOwner(() =>
    setAssignments(staffMem, [{ warehouseId: whA }, { warehouseId: whB, canManage: false }], orgId)
  );
  await asStaff(async () => {
    const scope = await warehouseScope();
    check('readable is exactly the two assigned', scope.readable?.length === 2);
    check('writable excludes the read-only one', scope.writable?.length === 1 && scope.writable[0] === whA);

    const list = await inventoryService.listWarehouses();
    check('list drops the unassigned warehouse', list.length === 2, `saw ${list.length}`);
    check('and it is Kano that is gone', !list.some((w) => w.id === whC));
  });

  // ── 3. Owners are never confined ─────────────────────────────────────────
  console.log('\nOwners are never confined');
  await asOwner(async () => {
    await db.warehouseAssignment.create({
      data: { organizationId: orgId, membershipId: ownerMem, warehouseId: whA },
    });
    const scope = await warehouseScope();
    check('owner scope stays unrestricted despite an assignment row', scope.readable === null);
    await db.warehouseAssignment.deleteMany({ where: { membershipId: ownerMem } });
  });

  // ── 4. Writes are refused outside the scope ──────────────────────────────
  console.log('\nWrites outside the scope are refused');
  await asStaff(async () => {
    check(
      'cannot adjust stock in an unassigned warehouse',
      await rejects(
        () => inventoryService.adjustStock(
          { variantId, warehouseId: whC, quantityChange: 5, reason: 'test' } as never,
          staffUserId
        ),
        /do not have permission|access to this warehouse/i
      )
    );
    check(
      'cannot adjust stock in a read-only warehouse',
      await rejects(
        () => inventoryService.adjustStock(
          { variantId, warehouseId: whB, quantityChange: 5, reason: 'test' } as never,
          staffUserId
        ),
        /do not have permission/i
      )
    );
    const ok = await inventoryService.adjustStock(
      { variantId, warehouseId: whA, quantityChange: 50, reason: 'test' } as never,
      staffUserId
    );
    check('can adjust stock in the warehouse they manage', !!ok);
  });

  // ── 5. Transfers need manage rights at BOTH ends ─────────────────────────
  console.log('\nA transfer needs manage rights at both ends');
  await asStaff(async () => {
    check(
      'refused when the destination is only readable',
      await rejects(
        () => inventoryService.createTransfer(
          { fromWarehouseId: whA, toWarehouseId: whB, items: [{ variantId, quantity: 1 }] } as never,
          staffUserId
        ),
        /do not have permission/i
      )
    );
    check(
      'refused when the destination is outside the scope entirely',
      await rejects(
        () => inventoryService.createTransfer(
          { fromWarehouseId: whA, toWarehouseId: whC, items: [{ variantId, quantity: 1 }] } as never,
          staffUserId
        ),
        /do not have permission/i
      )
    );
  });

  // ── 6. Reads by explicit id cannot escape the scope ──────────────────────
  console.log('\nNaming a warehouse id does not escape the scope');
  await asStaff(async () => {
    check(
      'listStock refuses an unassigned warehouseId',
      await rejects(() => inventoryService.listStock({ warehouseId: whC, limit: 20 } as never), /access to this warehouse/i)
    );
    check(
      'listMovements refuses an unassigned warehouseId',
      await rejects(() => inventoryService.listMovements({ warehouseId: whC, limit: 20 } as never), /access to this warehouse/i)
    );
  });

  // ── 7. Clearing assignments lifts the restriction ────────────────────────
  console.log('\nClearing the boxes lifts the restriction rather than locking out');
  await asOwner(async () => {
    const after = await setAssignments(staffMem, [], orgId);
    check('no rows remain', after.length === 0);
  });
  await asStaff(async () => {
    const scope = await warehouseScope();
    check('member is unrestricted again', scope.readable === null);
  });
  // Restore for the expiry test below.
  await asOwner(() => setAssignments(staffMem, [{ warehouseId: whA }], orgId));
  await asOwner(async () => {
    const rows = await listAssignments(staffMem);
    check('listAssignments names the warehouse', rows[0]?.warehouse.name === 'Lagos');
  });

  // ── 8. Expiry alerts ─────────────────────────────────────────────────────
  console.log('\nExpiry is flagged before it happens, not after');
  const mkBatch = async (warehouseId: string, batchNumber: string, days: number) =>
    db.stockMovement.create({
      data: {
        organizationId: orgId, warehouseId, variantId, type: 'PURCHASE_RECEIPT' as never,
        quantity: 10, batchNumber, expiryDate: new Date(Date.now() + days * 86_400_000),
      },
    });
  await mkBatch(whA, 'LOT-SOON', 5);      // inside the 14-day window
  await mkBatch(whA, 'LOT-GONE', -2);     // already expired
  await mkBatch(whA, 'LOT-LATER', 200);   // well outside the window
  await mkBatch(whC, 'LOT-OTHER', 3);     // a different warehouse

  const found = await findExpiring(orgId);
  const numbers = found.map((f) => f.batchNumber);
  check('flags the batch inside its window', numbers.includes('LOT-SOON'));
  check('flags the one already expired', numbers.includes('LOT-GONE'));
  check('ignores the one outside the window', !numbers.includes('LOT-LATER'));
  check('reports negative days for expired stock', (found.find((f) => f.batchNumber === 'LOT-GONE')?.daysToExpiry ?? 0) < 0);
  check('carries the unit through', found[0]?.unit === 'vial');

  // A product that does not track expiry is not the sweep's business.
  await db.product.update({ where: { id: productId }, data: { expiryTracked: false } });
  check('says nothing about a product that does not track expiry', (await findExpiring(orgId)).length === 0);
  await db.product.update({ where: { id: productId }, data: { expiryTracked: true } });

  console.log('\nThe alert reaches the people who can act on it');
  const before = await db.notification.count({ where: { organizationId: orgId } });
  await runExpirySweep(orgId);
  const notes = await db.notification.findMany({
    where: { organizationId: orgId, type: 'inventory.expiring' },
    select: { userId: true, title: true },
  });
  check('notifications were raised', notes.length > before);
  check('the owner is told', notes.some((n) => n.userId === ownerUserId));
  check(
    'the member assigned to that warehouse is told',
    notes.some((n) => n.userId === staffUserId && /Lagos/.test(n.title))
  );
  check(
    'and is not told about the warehouse they are not assigned to',
    !notes.some((n) => n.userId === staffUserId && /Kano/.test(n.title))
  );

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.notification.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.warehouseAssignment.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockTransferItem.deleteMany({ where: { transfer: { organizationId: orgId } } }).catch(() => {});
  await db.stockTransfer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockMovement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.stockLevel.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.productVariant.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.product.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.warehouse.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.membership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: [ownerUserId, staffUserId].filter(Boolean) } } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
