import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { inventoryService } from '../inventory/inventory.service';
import { filesService } from '../files/files.service';
import { exchangeRates } from '../../shared/exchange-rates';

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
  createdAt: true,
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

export const catalogService = {
  // ------------------------------------------------------------- products
  async listProducts(dto: ListProductsDto) {
    const rows = await prisma.product.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.brandId ? { brandId: dto.brandId } : {}),
        ...(dto.search
          ? {
              OR: [
                { name: { contains: dto.search, mode: 'insensitive' as const } },
                { variants: { some: { sku: { contains: dto.search, mode: 'insensitive' as const } } } },
                { variants: { some: { barcode: { contains: dto.search, mode: 'insensitive' as const } } } },
              ],
            }
          : {}),
      },
      select: productSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = await withImages(await inPreferredCurrency(
      (hasMore ? rows.slice(0, dto.limit) : rows).map(withStockTotals),
    ));
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async getProduct(id: string) {
    const product = await prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: productSelect,
    });
    if (!product) throw new NotFoundError('Product');
    const [resolved] = await withImages(await inPreferredCurrency([withStockTotals(product)]));
    return resolved!;
  },

  async createProduct(dto: CreateProductDto, currency: string) {
    const skus = dto.variants.map((v) => v.sku);
    const dupSku = await prisma.productVariant.findFirst({
      where: { sku: { in: skus }, deletedAt: null },
    });
    if (dupSku) throw new ConflictError(`SKU "${dupSku.sku}" is already in use`);

    const slug = await uniqueSlug('product', dto.name);
    const hasDefault = dto.variants.some((v) => v.isDefault);

    // Only touch inventory if some variant ships with opening stock.
    const needsStock = dto.variants.some((v) => Number(v.initialStock ?? 0) > 0);
    const warehouse = needsStock ? await inventoryService.ensureDefaultWarehouse() : null;
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
          status: dto.status,
          taxRate: dto.taxRate,
          customFields: dto.customFields ?? undefined,
          variants: {
            create: dto.variants.map((v, i) => ({
              organizationId: org,
              sku: v.sku,
              barcode: v.barcode ?? null,
              name: v.name ?? null,
              options: v.options ?? undefined,
              price: v.price,
              compareAtPrice: v.compareAtPrice ?? null,
              costPrice: v.costPrice ?? null,
              currency,
              isDefault: hasDefault ? Boolean(v.isDefault) : i === 0,
              isActive: v.isActive ?? true,
              imageFileId: v.imageFileId ?? null,
            })),
          },
        },
        select: productSelect,
      })) as unknown as CreatedProduct;

      if (warehouse) {
        for (const dv of dto.variants) {
          const qty = Number(dv.initialStock ?? 0);
          if (qty <= 0) continue;
          // Variants share the SKU we just created — match on it to get the id.
          const variant = created.variants.find((v) => v.sku === dv.sku);
          if (!variant) continue;
          await tx.stockLevel.create({
            data: { organizationId: org, warehouseId: warehouse.id, variantId: variant.id, quantity: qty },
          });
          await tx.stockMovement.create({
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
      }
      return created;
    });
    const [resolved] = await withImages(await inPreferredCurrency([withStockTotals(product)]));
    return resolved!;
  },

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.getProduct(id);
    const product = await prisma.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.taxRate !== undefined ? { taxRate: dto.taxRate } : {}),
      },
      select: productSelect,
    });
    const [resolved] = await withImages(await inPreferredCurrency([withStockTotals(product)]));
    return resolved!;
  },

  async deleteProduct(id: string) {
    await this.getProduct(id);
    await prisma.$transaction([
      prisma.product.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED' } }),
      prisma.productVariant.updateMany({
        where: { productId: id },
        data: { deletedAt: new Date(), isActive: false },
      }),
    ]);
  },

  // ------------------------------------------------------------- variants
  async addVariant(productId: string, dto: VariantDto, currency: string) {
    await this.getProduct(productId);
    const dup = await prisma.productVariant.findFirst({ where: { sku: dto.sku, deletedAt: null } });
    if (dup) throw new ConflictError(`SKU "${dto.sku}" is already in use`);

    const qty = Number(dto.initialStock ?? 0);
    const warehouse = qty > 0 ? await inventoryService.ensureDefaultWarehouse() : null;
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
          price: dto.price,
          compareAtPrice: dto.compareAtPrice ?? null,
          costPrice: dto.costPrice ?? null,
          currency,
          isDefault: dto.isDefault ?? false,
          isActive: dto.isActive ?? true,
          imageFileId: dto.imageFileId ?? null,
        },
      });
      if (warehouse && qty > 0) {
        await tx.stockLevel.create({
          data: { organizationId: org, warehouseId: warehouse.id, variantId: variant.id, quantity: qty },
        });
        await tx.stockMovement.create({
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
