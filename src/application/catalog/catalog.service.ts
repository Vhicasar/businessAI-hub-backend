import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { inventoryService } from '../inventory/inventory.service';
import { filesService } from '../files/files.service';
import { exchangeRates } from '../../shared/exchange-rates';
import { resolveEntitlements } from '../billing/entitlements';
import { reconcileSubscriptionDrafts } from '../billing/subscription-drafts.service';
import { productKindWhere } from './product-classification';

/** Nested creates bypass the tenant extension's data injection. */
function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
import type {
  CreateProductDto,
  ListProductsDto,
  ProductImageDto,
  UpdateProductDto,
  VariantDto,
} from './catalog.dto';

function slugify(name: string): string {
  return (
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) ||
    'item'
  );
}

async function uniqueSlug(
  table: 'product' | 'productCategory' | 'brand',
  name: string
): Promise<string> {
  const base = slugify(name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = prisma[table] as any;
  const clash = await model.findFirst({ where: { slug: base } });
  return clash ? `${base}-${Date.now().toString(36).slice(-4)}` : base;
}

const productSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  status: true,
  taxRate: true,
  /*
   * How the business counts this product.
   *
   * Settable since the batch/expiry work but never returned, so every edit
   * form loaded it as blank and saved that blank straight back — a product's
   * unit could be set once and was then quietly cleared by the next unrelated
   * edit.
   */
  unit: true,
  batchTracked: true,
  expiryTracked: true,
  shelfLifeDays: true,
  expiryAlertDays: true,
  weightGrams: true,
  manufacturingType: true,
  purchaseEnabled: true,
  sellable: true,
  manufacturingEnabled: true,
  createdAt: true,
  subscriptionDraftAt: true,
  subscriptionDraftReason: true,
  category: { select: { id: true, name: true } },
  brand: { select: { id: true, name: true } },
  images: {
    orderBy: { position: 'asc' as const },
    select: { id: true, fileId: true, altText: true, position: true },
  },
  variants: {
    where: { deletedAt: null },
    orderBy: { isDefault: 'desc' as const },
    select: {
      id: true,
      sku: true,
      barcode: true,
      name: true,
      options: true,
      price: true,
      compareAtPrice: true,
      costPrice: true,
      currency: true,
      isDefault: true,
      isActive: true,
      imageFileId: true,
      weightGrams: true,
      stockLevels: { select: { quantity: true, reserved: true } },
    },
  },
} as const;

function withStockTotals<T extends { variants: { stockLevels: { quantity: unknown; reserved: unknown }[] }[] }>(
  product: T
) {
  return {
    ...product,
    variants: product.variants.map((v) => {
      const onHand = v.stockLevels.reduce((s, l) => s + Number(l.quantity), 0);
      const reserved = v.stockLevels.reduce((s, l) => s + Number(l.reserved), 0);
      const { stockLevels: _levels, ...rest } = v;
      return { ...rest, stock: { onHand, reserved, available: onHand - reserved } };
    }),
  };
}

type ImageRow = { id: string; fileId: string; altText: string | null; position: number };
type WithImages = {
  images: ImageRow[];
  variants: { imageFileId: string | null }[];
};

/**
 * Turn File ids into browser URLs across a page of products in one batch — both
 * the product gallery (`images[].url`) and each variant's own photo
 * (`variant.imageUrl`). Signed R2 URLs are expensive to mint, so resolve every
 * id for the whole page in a single `urlMap` call rather than one lookup per row.
 */
async function withImages<T extends WithImages>(products: T[]): Promise<(T & { images: (ImageRow & { url: string | null })[] })[]> {
  const ids = new Set<string>();
  for (const p of products) {
    for (const img of p.images) ids.add(img.fileId);
    for (const v of p.variants) if (v.imageFileId) ids.add(v.imageFileId);
  }
  const urls = await filesService.urlMap([...ids]);
  return products.map((p) => ({
    ...p,
    images: p.images.map((img) => ({ ...img, url: urls.get(img.fileId) ?? null })),
    variants: p.variants.map((v) => ({ ...v, imageUrl: v.imageFileId ? urls.get(v.imageFileId) ?? null : null })),
  }));
}

async function inPreferredCurrency<T extends { variants: Array<{
  price: unknown;
  compareAtPrice: unknown | null;
  costPrice: unknown | null;
  currency: string;
}> }>(products: T[]): Promise<T[]> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { currency: true },
  });
  return Promise.all(products.map(async (product) => ({
    ...product,
    variants: await Promise.all(product.variants.map(async (variant) => {
      const convert = async (value: unknown | null) => value === null
        ? null
        : (await exchangeRates.convert(Number(value), variant.currency, org.currency)).amount;
      return {
        ...variant,
        price: await convert(variant.price),
        compareAtPrice: await convert(variant.compareAtPrice),
        costPrice: await convert(variant.costPrice),
        currency: org.currency,
        sourceCurrency: variant.currency,
      };
    })),
  })));
}

/**
 * How a product list can be ordered. Each ends with `id` so cursor paging has
 * a stable tiebreak — without it two products created in the same millisecond
 * can straddle a page boundary and appear twice or not at all.
 */
const PRODUCT_SORTS = {
  newest: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  oldest: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  name: [{ name: 'asc' as const }, { id: 'asc' as const }],
  name_desc: [{ name: 'desc' as const }, { id: 'desc' as const }],
};

export const catalogService = {
  // ------------------------------------------------------------- products
  async listProducts(dto: ListProductsDto) {
    const entitlements = await resolveEntitlements();
    await reconcileSubscriptionDrafts(entitlements);
    /*
     * Archiving a product soft-deletes it, so an ordinary listing — which
     * excludes soft-deleted rows — could never show one. Asking for the
     * archived ones therefore has to look on the other side of that line.
     *
     * Without this the Archived filter returned nothing, and archiving read as
     * permanent deletion: the product vanished from every view with no way to
     * see it again, let alone bring it back.
     *
     * Only this listing crosses the line. Everywhere else — analytics, AI
     * context, exports, component pickers — keeps treating soft-deleted as
     * gone, so nothing archived leaks into a place it does not belong.
     */
    const archivedOnly = dto.status === 'ARCHIVED';
    const rows = await prisma.product.findMany({
      where: {
        /*
         * Asking for archived products drops the soft-delete filter entirely
         * rather than inverting it.
         *
         * Archiving from the product page soft-deletes; setting the status to
         * Archived on the edit form does not. Both are archived as far as
         * anyone using the product is concerned, so matching only the
         * soft-deleted ones would hide half of them.
         */
        ...(archivedOnly ? {} : { deletedAt: null }),
        subscriptionDraftAt: dto.subscriptionState === 'draft' ? { not: null } : null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.brandId ? { brandId: dto.brandId } : {}),
        AND: [
          productKindWhere(dto.itemKind),
          ...(dto.search ? [{
              OR: [
                { name: { contains: dto.search, mode: 'insensitive' as const } },
                { variants: { some: { sku: { contains: dto.search, mode: 'insensitive' as const } } } },
                { variants: { some: { barcode: { contains: dto.search, mode: 'insensitive' as const } } } },
              ],
            }] : []),
        ],
      },
      select: productSelect,
      orderBy: PRODUCT_SORTS[dto.sort ?? 'newest'],
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = await withImages(await inPreferredCurrency(
      (hasMore ? rows.slice(0, dto.limit) : rows).map(withStockTotals),
    ));
    const subscriptionDraftCount = await prisma.product.count({
      where: { deletedAt: null, subscriptionDraftAt: { not: null }, ...productKindWhere(dto.itemKind) },
    });
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      subscriptionDraftCount,
      subscriptionRestricted: Boolean(entitlements.accessRestriction),
    };
  },

  /**
   * One product.
   *
   * `includeArchived` exists because archiving soft-deletes, and the product
   * page is the only place an archived product can be restored or removed for
   * good. Without it that page answered "not found" for exactly the products
   * it was needed for, so the Archived list led nowhere.
   *
   * Off by default: every other caller — updating, adding a variant, adjusting
   * stock — is asking about a product in circulation, and should not quietly
   * start operating on an archived one.
   */
  async getProduct(id: string, opts: { includeArchived?: boolean } = {}) {
    const product = await prisma.product.findFirst({
      where: { id, ...(opts.includeArchived ? {} : { deletedAt: null }) },
      select: productSelect,
    });
    if (!product) throw new NotFoundError('Product');
    const [resolved] = await withImages(await inPreferredCurrency([withStockTotals(product)]));
    return resolved!;
  },

  async createProduct(dto: CreateProductDto, currency: string, subscriptionDraftReason?: string) {
    const skus = dto.variants.map((v) => v.sku);
    const dupSku = await prisma.productVariant.findFirst({
      where: { sku: { in: skus }, deletedAt: null },
    });
    if (dupSku) throw new ConflictError(`SKU "${dupSku.sku}" is already in use`);

    const slug = await uniqueSlug('product', dto.name);
    const hasDefault = dto.variants.some((v) => v.isDefault);

    // Every variant gets an inventory row, even at zero. Otherwise a newly
    // created product exists in Catalog but is invisible in Inventory until a
    // later adjustment, which makes the successful create look like data loss.
    const warehouse = await inventoryService.ensureDefaultWarehouse();
    const org = orgId();

    type CreatedProduct = {
      images: ImageRow[];
      variants: {
        id: string;
        sku: string;
        imageFileId: string | null;
        price: unknown;
        compareAtPrice: unknown | null;
        costPrice: unknown | null;
        currency: string;
        stockLevels: { quantity: unknown; reserved: unknown }[];
      }[];
    } & Record<string, unknown>;
    const product = await prisma.$transaction(async (tx) => {
      const created = (await tx.product.create({
        data: {
          organizationId: org,
          name: dto.name,
          slug,
          description: dto.description ?? null,
          categoryId: dto.categoryId ?? null,
          brandId: dto.brandId ?? null,
          status: subscriptionDraftReason ? 'DRAFT' : dto.status,
          taxRate: dto.taxRate,
          manufacturingType: dto.manufacturingType ?? null,
          purchaseEnabled: dto.purchaseEnabled ?? true,
          // This is a domain rule, not a UI preference: manufacturing inputs
          // must never become sales candidates through a crafted request.
          sellable: dto.manufacturingType === 'RAW_MATERIAL' ? false : (dto.sellable ?? true),
          unit: dto.unit ?? null,
          batchTracked: dto.batchTracked ?? false,
          expiryTracked: dto.expiryTracked ?? false,
          shelfLifeDays: dto.shelfLifeDays ?? null,
          ...(dto.expiryAlertDays !== undefined ? { expiryAlertDays: dto.expiryAlertDays } : {}),
        ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
          ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
          customFields: dto.customFields ?? undefined,
          subscriptionDraftAt: subscriptionDraftReason ? new Date() : null,
          subscriptionDraftReason: subscriptionDraftReason ?? null,
          subscriptionDraftPreviousStatus: subscriptionDraftReason ? dto.status : null,
          variants: {
            create: dto.variants.map((v, i) => ({
              organizationId: org,
              sku: v.sku,
              barcode: v.barcode ?? null,
              name: v.name ?? null,
              options: v.options ?? undefined,
              // No price given — stored as zero rather than refused. A raw
              // material priced at nothing is accurate; one that cannot be
              // created at all is not.
              price: v.price ?? 0,
              compareAtPrice: v.compareAtPrice ?? null,
              costPrice: v.costPrice ?? null,
              currency,
              isDefault: hasDefault ? Boolean(v.isDefault) : i === 0,
              isActive: v.isActive ?? true,
              imageFileId: v.imageFileId ?? null,
              weightGrams: v.weightGrams ?? null,
            })),
          },
        },
        select: productSelect,
      })) as unknown as CreatedProduct;

      for (const dv of dto.variants) {
          const qty = Number(dv.initialStock ?? 0);
          // Variants share the SKU we just created — match on it to get the id.
          const variant = created.variants.find((v) => v.sku === dv.sku);
          if (!variant) continue;
          await tx.stockLevel.create({
            data: { organizationId: org, warehouseId: warehouse.id, variantId: variant.id, quantity: qty },
          });
          if (qty > 0) await tx.stockMovement.create({
            data: {
              organizationId: org,
              warehouseId: warehouse.id,
              variantId: variant.id,
              type: 'ADJUSTMENT',
              quantity: qty,
              reason: 'Opening stock',
              referenceType: 'ADJUSTMENT',
            },
          });
      }
      return created;
    });
    const [resolved] = await withImages(await inPreferredCurrency([withStockTotals(product)]));
    return resolved!;
  },

  async updateProduct(id: string, dto: UpdateProductDto) {
    const existing = await this.getProduct(id);
    if ((existing.manufacturingType === 'RAW_MATERIAL' || dto.manufacturingType === 'RAW_MATERIAL') && dto.sellable === true) {
      throw new ValidationError('Raw materials cannot be marked as sellable.');
    }
    const product = await prisma.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.batchTracked !== undefined ? { batchTracked: dto.batchTracked } : {}),
        ...(dto.expiryTracked !== undefined ? { expiryTracked: dto.expiryTracked } : {}),
        ...(dto.shelfLifeDays !== undefined ? { shelfLifeDays: dto.shelfLifeDays } : {}),
        ...(dto.expiryAlertDays !== undefined ? { expiryAlertDays: dto.expiryAlertDays } : {}),
        ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.taxRate !== undefined ? { taxRate: dto.taxRate } : {}),
        ...(dto.manufacturingType !== undefined ? { manufacturingType: dto.manufacturingType } : {}),
        ...(dto.purchaseEnabled !== undefined ? { purchaseEnabled: dto.purchaseEnabled } : {}),
        ...(dto.sellable !== undefined ? { sellable: dto.manufacturingType === 'RAW_MATERIAL' || existing.manufacturingType === 'RAW_MATERIAL' ? false : dto.sellable } : {}),
      },
      select: productSelect,
    });
    const [resolved] = await withImages(await inPreferredCurrency([withStockTotals(product)]));
    return resolved!;
  },

  async deleteProduct(id: string) {
    /*
     * Archiving something already archived used to report "Product not found",
     * because the lookup excluded archived rows — a confusing answer to a
     * reasonable action. It is read inclusively and refused on its own terms.
     */
    const existing = await this.getProduct(id, { includeArchived: true });
    if (existing.status === 'ARCHIVED') {
      throw new ConflictError(`"${existing.name}" is already archived.`);
    }
    await prisma.$transaction([
      prisma.product.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED' } }),
      prisma.productVariant.updateMany({
        where: { productId: id },
        data: { deletedAt: new Date(), isActive: false },
      }),
    ]);
  },

  /**
   * Bring an archived product back.
   *
   * The counterpart to archiving, and the thing that makes archiving something
   * other than a slow delete. Restores the variants too — they were
   * deactivated with it, and a product whose variants are all inactive is
   * back in the catalogue but cannot be sold.
   */
  async restoreProduct(id: string) {
    const product = await prisma.product.findFirst({
      where: { id },
      select: { id: true, name: true, status: true, deletedAt: true },
    });
    if (!product) throw new NotFoundError('Product');
    if (product.status !== 'ARCHIVED' && product.deletedAt === null) {
      throw new ValidationError('This product is not archived.');
    }
    await prisma.$transaction([
      prisma.product.update({ where: { id }, data: { deletedAt: null, status: 'ACTIVE' } }),
      prisma.productVariant.updateMany({
        where: { productId: id },
        data: { deletedAt: null, isActive: true },
      }),
    ]);
    return { restored: true, name: product.name };
  },

  /**
   * What a permanent delete would destroy, and what is standing in its way.
   *
   * Asked before the deed so the interface can say *why* rather than failing
   * at the database and showing a constraint name. Everything listed under
   * `blockedBy` is history or a live commitment: an order that was placed, a
   * production run that consumed it, stock that is still on a shelf. None of
   * those can be rewritten by removing the product they point at.
   */
  async purgePreflight(id: string) {
    const organizationId = orgId();
    const product = await prisma.product.findFirst({
      where: { id },
      select: { id: true, name: true, status: true, deletedAt: true, variants: { select: { id: true } } },
    });
    if (!product) throw new NotFoundError('Product');
    // An archived product is soft-deleted, so its variants are too — they must
    // still be counted, or the pre-flight reports a product with no variants
    // and the delete leaves them behind.
    const variantIds = product.variants.map((v) => v.id);

    const [orderItems, movements, batches, cartItems, bomUses, productionMaterials, receipts, requisitions, stock] =
      await Promise.all([
        prisma.orderItem.count({ where: { variantId: { in: variantIds } } }),
        prisma.stockMovement.count({ where: { variantId: { in: variantIds } } }),
        prisma.batch.count({ where: { variantId: { in: variantIds } } }),
        prisma.cartItem.count({ where: { variantId: { in: variantIds } } }),
        prisma.billOfMaterialItem.count({ where: { variantId: { in: variantIds } } }),
        prisma.productionMaterial.count({ where: { variantId: { in: variantIds } } }),
        prisma.finishedGoodsReceipt.count({ where: { variantId: { in: variantIds } } }),
        prisma.internalRequisitionItem.count({ where: { variantId: { in: variantIds } } }),
        prisma.stockLevel.findMany({
          where: { variantId: { in: variantIds } },
          select: { quantity: true, reserved: true },
        }),
      ]);
    const onHand = stock.reduce((sum, level) => sum + Number(level.quantity) + Number(level.reserved), 0);
    const ownRecipes = await prisma.billOfMaterial.count({ where: { productId: id } });

    const blockedBy: { reason: string; count: number }[] = [];
    const block = (reason: string, count: number) => { if (count > 0) blockedBy.push({ reason, count }); };
    block('appears on customer orders', orderItems);
    block('has batches recorded', batches);
    block('is in a shopping cart', cartItems);
    block('is used as a component in a recipe', bomUses);
    block('has been consumed by production', productionMaterials);
    block('has been received from production', receipts);
    block('appears on an internal requisition', requisitions);
    if (onHand > 0) blockedBy.push({ reason: 'still has stock on hand or reserved', count: Math.round(onHand) });

    return {
      productId: product.id,
      name: product.name,
      /*
       * Stock movements do not block.
       *
       * They are this product's own inventory bookkeeping, and a product being
       * deleted on purpose takes its bookkeeping with it — blocking on them
       * would make any product that ever had opening stock permanently
       * undeletable, which is every product. What does block is stock that is
       * actually there: deleting a product sitting on a shelf loses it.
       */
      movements,
      archived: product.status === 'ARCHIVED' || product.deletedAt !== null,
      canPurge: blockedBy.length === 0 && (product.status === 'ARCHIVED' || product.deletedAt !== null),
      blockedBy,
      /** Removed along with it — these belong to the product and nothing else. */
      alsoRemoved: {
        variants: variantIds.length,
        recipes: ownRecipes,
      },
      organizationId,
    };
  },

  /**
   * Remove a product for good.
   *
   * Only for one that is already archived. Archiving is the reversible step and
   * the one people reach for; this is the irreversible one, and offering them
   * side by side is how a catalogue loses a product somebody still needed.
   *
   * Refuses outright when anything references it. The pre-flight above says
   * what, so the refusal names the obstacle rather than surfacing a foreign key
   * violation.
   */
  async purgeProduct(id: string) {
    const check = await this.purgePreflight(id);
    if (!check.archived) {
      throw new ValidationError('Only an archived product can be permanently deleted. Archive it first.');
    }
    if (check.blockedBy.length > 0) {
      throw new ConflictError(
        `"${check.name}" cannot be permanently deleted because it ${check.blockedBy.map((b) => b.reason).join(', and ')}.`,
        { blockedBy: check.blockedBy },
      );
    }

    const images = await prisma.productImage.findMany({ where: { productId: id }, select: { fileId: true } });

    await prisma.$transaction(async (tx) => {
      const variants = await tx.productVariant.findMany({ where: { productId: id }, select: { id: true } });
      const variantIds = variants.map((v) => v.id);
      // Everything below belongs to the product rather than recording anything
      // that happened, so it goes with it.
      await tx.billOfMaterialItem.deleteMany({ where: { bom: { productId: id } } });
      await tx.billOfMaterial.deleteMany({ where: { productId: id } });
      await tx.priceListItem.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.supplierProduct.deleteMany({ where: { productId: id } });
      await tx.productExternalReference.deleteMany({ where: { productId: id } });
      await tx.productImage.deleteMany({ where: { productId: id } });
      await tx.stockMovement.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.stockLevel.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.productVariant.deleteMany({ where: { productId: id } });
      await tx.product.delete({ where: { id } });
    });

    // The gallery rows are gone; drop the files they were holding.
    for (const image of images) await filesService.remove(image.fileId).catch(() => undefined);
    return { deleted: true, permanent: true };
  },

  // ------------------------------------------------------------- variants
  async addVariant(productId: string, dto: VariantDto, currency: string) {
    await this.getProduct(productId);
    const dup = await prisma.productVariant.findFirst({ where: { sku: dto.sku, deletedAt: null } });
    if (dup) throw new ConflictError(`SKU "${dto.sku}" is already in use`);

    const qty = Number(dto.initialStock ?? 0);
    const warehouse = await inventoryService.ensureDefaultWarehouse();
    const org = orgId();

    return prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.create({
        data: {
          organizationId: org,
          productId,
          sku: dto.sku,
          barcode: dto.barcode ?? null,
          name: dto.name ?? null,
          options: dto.options ?? undefined,
          price: dto.price ?? 0,
          compareAtPrice: dto.compareAtPrice ?? null,
          costPrice: dto.costPrice ?? null,
          currency,
          isDefault: dto.isDefault ?? false,
          isActive: dto.isActive ?? true,
          imageFileId: dto.imageFileId ?? null,
          weightGrams: dto.weightGrams ?? null,
        },
      });
      await tx.stockLevel.create({
        data: { organizationId: org, warehouseId: warehouse.id, variantId: variant.id, quantity: qty },
      });
      if (qty > 0) await tx.stockMovement.create({
          data: {
            organizationId: org,
            warehouseId: warehouse.id,
            variantId: variant.id,
            type: 'ADJUSTMENT',
            quantity: qty,
            reason: 'Opening stock',
            referenceType: 'ADJUSTMENT',
          },
        });
      return variant;
    });
  },

  async updateVariant(productId: string, variantId: string, dto: VariantDto) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, deletedAt: null },
    });
    if (!variant) throw new NotFoundError('Variant');
    if (dto.sku !== variant.sku) {
      const dup = await prisma.productVariant.findFirst({
        where: { sku: dto.sku, deletedAt: null, id: { not: variantId } },
      });
      if (dup) throw new ConflictError(`SKU "${dto.sku}" is already in use`);
    }
    const updated = await prisma.productVariant.update({
      where: { id: variantId },
      data: {
        sku: dto.sku,
        barcode: dto.barcode ?? null,
        name: dto.name ?? null,
        options: dto.options ?? undefined,
        price: dto.price,
        compareAtPrice: dto.compareAtPrice ?? null,
        costPrice: dto.costPrice ?? null,
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.imageFileId !== undefined ? { imageFileId: dto.imageFileId } : {}),
        ...(dto.weightGrams !== undefined ? { weightGrams: dto.weightGrams } : {}),
      },
    });
    // Swapped the variant photo → delete the file it replaced so orphans don't pile up.
    if (dto.imageFileId !== undefined && variant.imageFileId && variant.imageFileId !== dto.imageFileId) {
      await filesService.remove(variant.imageFileId).catch(() => undefined);
    }
    return updated;
  },

  async deleteVariant(productId: string, variantId: string) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, deletedAt: null },
    });
    if (!variant) throw new NotFoundError('Variant');
    const count = await prisma.productVariant.count({
      where: { productId, deletedAt: null },
    });
    if (count <= 1) throw new ConflictError('A product needs at least one variant');
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { deletedAt: new Date(), isActive: false },
    });
  },

  // ---------------------------------------------------- product gallery
  /** Append an already-uploaded image to a product's gallery. */
  async addProductImage(productId: string, dto: ProductImageDto) {
    await this.getProduct(productId);
    // New images go to the end; position is 1-based on the current count.
    const count = await prisma.productImage.count({ where: { productId } });
    const image = await prisma.productImage.create({
      data: { productId, fileId: dto.fileId, altText: dto.altText ?? null, position: count },
      select: { id: true, fileId: true, altText: true, position: true },
    });
    return { ...image, url: await filesService.urlFor(image.fileId) };
  },

  async removeProductImage(productId: string, imageId: string) {
    const image = await prisma.productImage.findFirst({ where: { id: imageId, productId } });
    if (!image) throw new NotFoundError('Image');
    await prisma.productImage.delete({ where: { id: imageId } });
    // The gallery row is gone; drop the backing file too.
    await filesService.remove(image.fileId).catch(() => undefined);
    return { deleted: true };
  },

  /** Persist a new gallery order. Ignores ids that aren't on this product. */
  async reorderProductImages(productId: string, order: string[]) {
    const images = await prisma.productImage.findMany({ where: { productId }, select: { id: true } });
    const own = new Set(images.map((i) => i.id));
    await prisma.$transaction(
      order
        .filter((id) => own.has(id))
        .map((id, position) => prisma.productImage.update({ where: { id }, data: { position } }))
    );
    return this.getProduct(productId);
  },

  /** Attach or clear a single variant's photo, cleaning up any replaced file. */
  async setVariantImage(productId: string, variantId: string, fileId: string | null) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, deletedAt: null },
      select: { id: true, imageFileId: true },
    });
    if (!variant) throw new NotFoundError('Variant');
    await prisma.productVariant.update({ where: { id: variantId }, data: { imageFileId: fileId } });
    if (variant.imageFileId && variant.imageFileId !== fileId) {
      await filesService.remove(variant.imageFileId).catch(() => undefined);
    }
    return { imageFileId: fileId, imageUrl: await filesService.urlFor(fileId) };
  },

  // -------------------------------------------------- categories & brands
  async listCategories() {
    return prisma.productCategory.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, slug: true, parentId: true, position: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  async createCategory(name: string, parentId?: string | null) {
    return prisma.productCategory.create({
      data: { organizationId: orgId(), name, slug: await uniqueSlug('productCategory', name), parentId: parentId ?? null },
    });
  },

  async deleteCategory(id: string) {
    const inUse = await prisma.product.count({ where: { categoryId: id, deletedAt: null } });
    if (inUse > 0) throw new ConflictError('Category has products — reassign them first');
    await prisma.productCategory.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  async listBrands() {
    return prisma.brand.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
  },

  async createBrand(name: string) {
    return prisma.brand.create({
      data: { organizationId: orgId(), name, slug: await uniqueSlug('brand', name) },
    });
  },

  async deleteBrand(id: string) {
    const inUse = await prisma.product.count({ where: { brandId: id, deletedAt: null } });
    if (inUse > 0) throw new ConflictError('Brand has products — reassign them first');
    await prisma.brand.update({ where: { id }, data: { deletedAt: new Date() } });
  },
};
