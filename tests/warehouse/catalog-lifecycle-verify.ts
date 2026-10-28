/**
 * A product's life: active → archived → back, or archived → gone for good.
 *
 * The reported fault was that archiving behaved like a permanent delete — the
 * product vanished from every view, including the Archived filter, with no way
 * to see it again. These checks pin down each step of that path.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { catalogService } from '../../src/application/catalog/catalog.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '';
const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `cat-${stamp}`, organizationId: orgId, userId }, fn);

const list = (over: Record<string, unknown> = {}) => asOrg(() => catalogService.listProducts({
  itemKind: 'ALL', subscriptionState: 'active', sort: 'newest', limit: 100, ...over,
} as never)) as Promise<{ items: { id: string; name: string; status: string }[] }>;

async function main() {
  const org = await db.organization.create({
    data: { name: `Cat Verify ${stamp}`, slug: `cat-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `cat-verify-${stamp}@example.invalid`, firstName: 'Cat', lastName: 'Verify', passwordHash: 'x' },
  });
  userId = user.id;

  const widget = await asOrg(() => catalogService.createProduct({
    name: `Widget ${stamp}`, status: 'ACTIVE', taxRate: 0,
    variants: [{ sku: `W-${stamp}`, price: 500, isDefault: true }],
  } as never, 'NGN')) as Record<string, unknown>;
  const widgetId = String(widget.id);

  // ── Archiving ───────────────────────────────────────────────────────────
  console.log('\nArchiving is not deletion');
  let active = await list({ status: 'ACTIVE' });
  check('a new product is listed as active', active.items.some((p) => p.id === widgetId));

  await asOrg(() => catalogService.deleteProduct(widgetId));
  const row = await db.product.findUniqueOrThrow({ where: { id: widgetId }, select: { status: true, deletedAt: true } });
  check('archiving keeps the row', row.status === 'ARCHIVED');

  active = await list({ status: 'ACTIVE' });
  check('and takes it out of the active list', !active.items.some((p) => p.id === widgetId));

  const archived = await list({ status: 'ARCHIVED' });
  check('but it appears under Archived', archived.items.some((p) => p.id === widgetId),
    `archived list had ${archived.items.length}`);

  const unfiltered = await list();
  check('and stays out of the unfiltered list', !unfiltered.items.some((p) => p.id === widgetId));

  // ── Restoring ───────────────────────────────────────────────────────────
  console.log('\nComing back');
  await asOrg(() => catalogService.restoreProduct(widgetId));
  const back = await db.product.findUniqueOrThrow({ where: { id: widgetId }, select: { status: true, deletedAt: true } });
  check('restoring makes it active again', back.status === 'ACTIVE' && back.deletedAt === null);
  const variants = await db.productVariant.findMany({ where: { productId: widgetId }, select: { isActive: true, deletedAt: true } });
  check('and its variants are sellable again',
    variants.every((v) => v.isActive && v.deletedAt === null));
  active = await list({ status: 'ACTIVE' });
  check('it is back in the active list', active.items.some((p) => p.id === widgetId));

  let notArchived = '';
  await asOrg(async () => {
    try { await catalogService.restoreProduct(widgetId); }
    catch (err) { notArchived = (err as Error).message; }
  });
  check('restoring something that is not archived is refused', /not archived/i.test(notArchived), notArchived);

  // ── Permanent delete reaches an archived product ────────────────────────
  console.log('\nPermanent delete, from the archive');
  await asOrg(() => catalogService.deleteProduct(widgetId));
  const pre = await asOrg(() => catalogService.purgePreflight(widgetId));
  check('an archived product can be examined for deletion', pre.archived === true);
  check('and it knows about its variants', pre.alsoRemoved.variants === 1, String(pre.alsoRemoved.variants));
  check('and reports as deletable', pre.canPurge === true, JSON.stringify(pre.blockedBy));

  await asOrg(() => catalogService.purgeProduct(widgetId));
  check('it is gone', (await db.product.count({ where: { id: widgetId } })) === 0);
  check('with no variants left behind', (await db.productVariant.count({ where: { productId: widgetId } })) === 0);

  // ── Raw materials ───────────────────────────────────────────────────────
  console.log('\nRaw materials');
  const flour = await asOrg(() => catalogService.createProduct({
    name: `Flour ${stamp}`, status: 'ACTIVE', taxRate: 0, manufacturingType: 'RAW_MATERIAL',
    variants: [{ sku: `RM-FLR-${stamp}`, isDefault: true }],
  } as never, 'NGN')) as Record<string, unknown>;
  const flourId = String(flour.id);
  check('a raw material can be created without a price', Boolean(flourId));
  const flourVariant = await db.productVariant.findFirstOrThrow({ where: { productId: flourId }, select: { price: true } });
  check('and its price records as nothing rather than being refused', Number(flourVariant.price) === 0);

  await asOrg(() => catalogService.deleteProduct(flourId));
  const archivedRaw = await list({ status: 'ARCHIVED', itemKind: 'RAW_MATERIAL' });
  check('an archived raw material appears under Archived too',
    archivedRaw.items.some((p) => p.id === flourId), `got ${archivedRaw.items.length}`);
  await asOrg(() => catalogService.restoreProduct(flourId));
  const rawBack = await db.product.findUniqueOrThrow({ where: { id: flourId }, select: { status: true } });
  check('and can be restored', rawBack.status === 'ACTIVE');

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
  ]) await run().catch((e) => console.log(`  (cleanup: ${(e as Error).message.split('\n')[0].slice(0, 80)})`));
}

main()
  .catch((err) => { failed++; console.error('\nFATAL', err); })
  .finally(async () => { await cleanup(); await db.$disconnect(); process.exit(failed === 0 ? 0 : 1); });
