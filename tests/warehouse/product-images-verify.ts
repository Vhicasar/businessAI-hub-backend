/*
 * Putting a photo on a product, the way the phone now does it.
 *
 * Three steps, and the order matters: the file is uploaded on its own, the
 * product is created, and only then can a photo point at it. The phone
 * uploads as each picture is chosen and attaches after the save, so what is
 * checked here is that the server accepts exactly that sequence — and that
 * detaching a photo leaves the file alone, since the same file may illustrate
 * something else.
 */
import { readFileSync } from 'node:fs';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { catalogService } from '../../src/application/catalog/catalog.service';
import { filesService } from '../../src/application/files/files.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try { await fn(); return false; } catch { return true; }
};

const stamp = Date.now();
let orgId = '', userId = '', productId = '';

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

/** The smallest valid PNG — enough for the pipeline to be real. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const upload = (name: string) =>
  filesService.upload(
    { buffer: PNG, originalname: name, mimetype: 'image/png', size: PNG.length } as never,
    { organizationId: orgId, uploadedById: userId, entity: 'product', isPublic: true },
  );

async function main() {
  const org = await db.organization.create({
    data: { name: 'Photo Co', slug: `photo-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  userId = (await db.user.create({
    data: { email: `photo-${stamp}@t.test`, passwordHash: 'x', firstName: 'Photo', lastName: 'T' },
  })).id;
  await db.warehouse.create({
    data: { organizationId: orgId, name: 'Main', code: `PT-${stamp}`, isDefault: true },
  });

  // ── 1. A file uploads on its own ─────────────────────────────────────────
  console.log('\nA photo is uploaded before it belongs to anything');
  let fileId = '';
  await as(async () => {
    const file = await upload('shelf.png');
    fileId = (file as { id: string }).id;
    check('the upload returns an id', Boolean(fileId));
    check('and a url to show it by', Boolean((file as { url?: string }).url));

    const row = await db.file.findFirst({
      where: { id: fileId },
      select: { key: true, mimeType: true, fileName: true },
    });
    // `entity` shapes where the file is stored rather than a column of its
    // own, so it is the storage key that shows what the upload was for.
    check('stored under what it illustrates', (row?.key ?? '').includes('product'), row?.key);
    check('and keeps its type', row?.mimeType === 'image/png');
    check('and its name', row?.fileName === 'shelf.png');
  });

  // ── 2. It attaches to a product that exists ──────────────────────────────
  console.log('\nAnd attaches once the product exists');
  await as(async () => {
    const product = await catalogService.createProduct(
      {
        name: 'Bag of Rice',
        status: 'ACTIVE',
        taxRate: 0,
        variants: [{ sku: `RICE-${stamp}`, price: 55000, isDefault: true }],
      } as never,
      'NGN',
    );
    productId = product.id;
    check('a new product starts with no photos', product.images.length === 0);

    await catalogService.addProductImage(productId, { fileId } as never);
    const withPhoto = await catalogService.getProduct(productId);
    check('the photo is on it', withPhoto.images.length === 1);
    check('pointing at the file that was uploaded', withPhoto.images[0]!.fileId === fileId);
    check('and carries a url the phone can draw',
      Boolean((withPhoto.images[0] as { url?: string }).url));
  });

  // ── 3. Several photos keep their order ───────────────────────────────────
  console.log('\nSeveral photos keep the order they were added in');
  await as(async () => {
    const second = (await upload('side.png') as { id: string }).id;
    const third = (await upload('back.png') as { id: string }).id;
    await catalogService.addProductImage(productId, { fileId: second } as never);
    await catalogService.addProductImage(productId, { fileId: third } as never);

    const product = await catalogService.getProduct(productId);
    check('all three are attached', product.images.length === 3);
    check('positions are distinct',
      new Set(product.images.map((i) => i.position)).size === 3);
    check('the first one added is still first',
      product.images[0]!.fileId === fileId,
      'the phone treats the first as the main photo');
  });

  // ── 4. Detaching leaves the file alone ───────────────────────────────────
  console.log('\nTaking a photo off a product does not destroy the file');
  await as(async () => {
    const product = await catalogService.getProduct(productId);
    const target = product.images[1]!;
    await catalogService.removeProductImage(productId, target.id);

    const after = await catalogService.getProduct(productId);
    check('it is off the product', after.images.length === 2);
    check('and not one of them', !after.images.some((i) => i.id === target.id));

    const file = await db.file.findFirst({ where: { id: target.fileId }, select: { id: true } });
    check('but the file itself survives', Boolean(file),
      'the same file could illustrate something else');
  });

  // ── 5. What the server refuses ───────────────────────────────────────────
  console.log('\nA photo cannot point at nothing');
  await as(async () => {
    check('an unknown file is refused',
      await rejects(() => catalogService.addProductImage(productId, { fileId: 'no-such-file' } as never)));
    check('an unknown product is refused',
      await rejects(() => catalogService.addProductImage('no-such-product', { fileId } as never)));
  });

  // ── 6. The phone's field agrees with the server's shape ──────────────────
  console.log('\nThe phone reads the fields the server actually returns');
  {
    const dart = readFileSync(
      '../flutter/lib/features/tablet/module_form_sheet.dart',
      'utf8',
    );
    // Seeding an existing gallery reads these three off each image.
    for (const key of ['fileId', 'url', 'id']) {
      check(`the form reads ${key} off an existing image`,
        new RegExp(`raw\\['${key}'\\]`).test(dart));
    }
    const product = await as(() => catalogService.getProduct(productId));
    const shape = product.images[0] as Record<string, unknown>;
    for (const key of ['fileId', 'url', 'id']) {
      check(`and the server returns ${key}`, key in shape);
    }
  }

  // ── 7. The phone is allowed to open the camera and the gallery ───────────
  console.log('\nThe app declares what it needs to take and pick a photo');
  {
    const plist = readFileSync('../flutter/ios/Runner/Info.plist', 'utf8');
    // iOS terminates an app that opens either of these without a reason
    // string, so a missing one is not a warning — it is a crash the moment a
    // shopkeeper taps the button.
    check('iOS asks for the camera', plist.includes('NSCameraUsageDescription'));
    check('iOS asks for the photo library', plist.includes('NSPhotoLibraryUsageDescription'));
    check('and the camera reason mentions photos, not only scanning',
      /NSCameraUsageDescription<\/key>\s*<string>[^<]*photo/i.test(plist),
      'the string still only describes code scanning');

    const manifest = readFileSync(
      '../flutter/android/app/src/main/AndroidManifest.xml',
      'utf8',
    );
    check('Android asks for the camera', manifest.includes('android.permission.CAMERA'));
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  const org = { organizationId: orgId };
  await db.productImage.deleteMany({ where: { product: org } }).catch(() => {});
  await db.stockLevel.deleteMany({ where: org }).catch(() => {});
  await db.productVariant.deleteMany({ where: org }).catch(() => {});
  await db.product.deleteMany({ where: org }).catch(() => {});
  await db.file.deleteMany({ where: org }).catch(() => {});
  await db.warehouse.deleteMany({ where: org }).catch(() => {});
  await db.auditLog.deleteMany({ where: org }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
