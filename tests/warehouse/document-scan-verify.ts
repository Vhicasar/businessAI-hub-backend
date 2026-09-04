/*
 * Scannable documents, and who may act on what they scanned.
 *
 * The promise under test is that a QR code identifies a document without
 * authorising anything: two people scanning the same job card are offered
 * different actions, and the one who tries an action they were not offered is
 * refused by the server rather than by the phone.
 *
 * Also covers the per-action permission on production order transitions —
 * approve, start, complete and cancel share one endpoint whose route guard is
 * ANY-of, so without a service-level check a cancel-only operator could
 * approve and start runs.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { documentQrService } from '../../src/application/documents/document-qr.service';
import { productionOrdersService } from '../../src/application/manufacturing/production-orders.service';
import { invalidateRoleCache } from '../../src/application/roles/role-permissions';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgId = '', productId = '', variantId = '', wh = '', bomId = '', orderId = '', payload = '';
let approverRole = '', starterRole = '', cancelRole = '';
let approverUser = '', approverMem = '', starterUser = '', starterMem = '', cancelUser = '', cancelMem = '';

const as = <T>(userId: string, membershipId: string, roleId: string, fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId, membershipId, roleId } as never, fn);

/** A role holding exactly the given permission keys. */
async function roleWith(name: string, keys: string[]): Promise<string> {
  const role = await db.role.create({ data: { organizationId: orgId, name, isSystem: false } });
  for (const key of keys) {
    const perm = await db.permission.findFirst({ where: { key }, select: { id: true } });
    if (!perm) throw new Error(`Permission ${key} is not in the catalogue`);
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  return role.id;
}

async function member(email: string, roleId: string): Promise<{ userId: string; memId: string }> {
  const u = await db.user.create({
    data: { email, passwordHash: 'x', firstName: email.slice(0, 4), lastName: 'T', emailVerifiedAt: new Date() },
  });
  const m = await db.membership.create({
    data: { organizationId: orgId, userId: u.id, roleId, isOwner: false },
  });
  return { userId: u.id, memId: m.id };
}

async function main() {
  const org = await db.organization.create({
    data: { name: 'Scan Co', slug: `scan-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  wh = (await db.warehouse.create({
    data: { organizationId: orgId, name: 'Plant', code: `SC-${stamp}`, isDefault: true },
  })).id;
  const product = await db.product.create({
    data: { organizationId: orgId, name: 'Widget', slug: `widget-${stamp}`, type: 'PHYSICAL' as never, unit: 'case' },
  });
  productId = product.id;
  variantId = (await db.productVariant.create({
    data: { organizationId: orgId, productId, sku: `WID-${stamp}`, price: 100 },
  })).id;
  bomId = (await db.billOfMaterial.create({
    data: {
      organizationId: orgId, productId, bomNumber: `BOM-${stamp}`, version: 1,
      status: 'ACTIVE', outputQuantity: 100, warehouseId: wh,
    },
  })).id;
  const order = await db.productionOrder.create({
    data: {
      organizationId: orgId, orderNumber: `MO-${stamp}`, productId, bomId,
      plannedQuantity: 100, status: 'DRAFT', warehouseId: wh, finishedWarehouseId: wh,
    },
  });
  orderId = order.id;

  approverRole = await roleWith('Approver', ['production.read', 'production.approve']);
  starterRole = await roleWith('Line lead', ['production.read', 'production.start']);
  cancelRole = await roleWith('Cancel only', ['production.read', 'production.cancel']);
  ({ userId: approverUser, memId: approverMem } = await member(`app-${stamp}@t.test`, approverRole));
  ({ userId: starterUser, memId: starterMem } = await member(`sta-${stamp}@t.test`, starterRole));
  ({ userId: cancelUser, memId: cancelMem } = await member(`can-${stamp}@t.test`, cancelRole));
  invalidateRoleCache();

  // ── 1. A code is minted and resolves ─────────────────────────────────────
  console.log('\nA job card carries a code that resolves to its order');
  await as(approverUser, approverMem, approverRole, async () => {
    const minted = await documentQrService.productionOrderPayload(orderId);
    payload = minted.payload;
    check('payload uses the existing vhicasar:// convention', /^vhicasar:\/\/mo\/.+$/.test(payload), payload);
    check('and names the right order', minted.orderNumber === `MO-${stamp}`);

    const again = await documentQrService.productionOrderPayload(orderId);
    check('the same order always mints the same code', again.payload === payload);

    const doc = await documentQrService.resolve(payload);
    check('resolves to the production order', doc.id === orderId);
    check('shows what it is', doc.title === `MO-${stamp}` && doc.kind === 'mo');
    check('carries the unit into the subtitle', (doc.subtitle ?? '').includes('case'));
    check('reports its status', doc.status === 'DRAFT');
  });

  // ── 2. Codes are rejected, not guessed at ────────────────────────────────
  console.log('\nA code that is not ours is refused');
  await as(approverUser, approverMem, approverRole, async () => {
    check('a random string is refused',
      await rejects(() => documentQrService.resolve('just-some-text'), /does not look like/i));
    check('a well-formed but unknown token is refused',
      await rejects(() => documentQrService.resolve('vhicasar://mo/deadbeefdeadbeef'), /not found|Production order/i));
  });

  // ── 3. The same card offers different actions to different people ────────
  console.log('\nThe same card offers each person only what their role allows');
  await as(approverUser, approverMem, approverRole, async () => {
    const doc = await documentQrService.resolve(payload);
    const approve = doc.actions.find((a) => a.key === 'approve');
    const start = doc.actions.find((a) => a.key === 'start');
    check('the approver is offered Approve', approve?.allowed === true);
    check('and is not offered Start', start?.allowed === false);
    check('Approve is available at DRAFT', approve?.blockedReason === undefined);
    check('Start is blocked at DRAFT with a reason', typeof start?.blockedReason === 'string');
  });
  await as(starterUser, starterMem, starterRole, async () => {
    const doc = await documentQrService.resolve(payload);
    check('the line lead is offered Start', doc.actions.find((a) => a.key === 'start')?.allowed === true);
    check('and is not offered Approve', doc.actions.find((a) => a.key === 'approve')?.allowed === false);
  });

  // ── 4. The offer is a hint; the server is the gate ───────────────────────
  console.log('\nIgnoring what you were offered gets you nowhere');
  await as(starterUser, starterMem, starterRole, async () => {
    check('a line lead cannot approve, however they call it',
      await rejects(() => productionOrdersService.transition(orderId, 'APPROVED'), /do not have permission to approve/i));
  });
  await as(cancelUser, cancelMem, cancelRole, async () => {
    check('a cancel-only operator cannot approve',
      await rejects(() => productionOrdersService.transition(orderId, 'APPROVED'), /do not have permission to approve/i));
  });

  console.log('\nAnd the right person can still do the job');
  await as(approverUser, approverMem, approverRole, async () => {
    const approved = await productionOrdersService.transition(orderId, 'APPROVED');
    check('the approver approves it', approved.status === 'APPROVED');
  });
  await as(cancelUser, cancelMem, cancelRole, async () => {
    check('the cancel-only operator still cannot start it',
      await rejects(() => productionOrdersService.transition(orderId, 'IN_PROGRESS'), /do not have permission to start/i));
  });
  await as(starterUser, starterMem, starterRole, async () => {
    const started = await productionOrdersService.transition(orderId, 'IN_PROGRESS');
    check('the line lead starts it', started.status === 'IN_PROGRESS');
    const doc = await documentQrService.resolve(payload);
    check('the card now offers Pause', doc.actions.find((a) => a.key === 'pause')?.blockedReason === undefined);
    check('and no longer offers Start', typeof doc.actions.find((a) => a.key === 'start')?.blockedReason === 'string');
    check('completing is not theirs to do',
      await rejects(() => productionOrdersService.transition(orderId, 'COMPLETED'), /do not have permission to complete/i));
  });

  // ── 5. Owners are not confined by any of this ────────────────────────────
  console.log('\nAn owner is never blocked by a narrow role');
  const ownerUser = await db.user.create({
    data: { email: `own-${stamp}@t.test`, passwordHash: 'x', firstName: 'Owner', lastName: 'T', emailVerifiedAt: new Date() },
  });
  const ownerMem = await db.membership.create({
    data: { organizationId: orgId, userId: ownerUser.id, roleId: cancelRole, isOwner: true },
  });
  await as(ownerUser.id, ownerMem.id, cancelRole, async () => {
    const doc = await documentQrService.resolve(payload);
    check('every action is offered to the owner', doc.actions.every((a) => a.allowed));
    const done = await productionOrdersService.transition(orderId, 'COMPLETED');
    check('and the owner can complete the run', done.status === 'COMPLETED');
  });

  // ── 6. A finished order stops offering actions ───────────────────────────
  console.log('\nA finished order offers nothing further');
  await as(approverUser, approverMem, approverRole, async () => {
    const doc = await documentQrService.resolve(payload);
    check('every action is blocked with a reason',
      doc.actions.every((a) => typeof a.blockedReason === 'string'));
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.productionOrder.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.billOfMaterialItem.deleteMany({ where: { bom: { organizationId: orgId } } }).catch(() => {});
  await db.billOfMaterial.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.productVariant.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.product.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.warehouse.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.membership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } }).catch(() => {});
  await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.deleteMany({
    where: { id: { in: [approverUser, starterUser, cancelUser].filter(Boolean) } },
  }).catch(() => {});
  await db.user.deleteMany({ where: { email: { contains: `-${stamp}@t.test` } } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
