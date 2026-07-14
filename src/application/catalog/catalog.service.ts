import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

/** Nested creates bypass the tenant extension's data injection. */
function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
import type {
  CreateProductDto,
  ListProductsDto,
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
    const items = (hasMore ? rows.slice(0, dto.limit) : rows).map(withStockTotals);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async getProduct(id: string) {
    const product = await prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: productSelect,
    });
    if (!product) throw new NotFoundError('Product');
    return withStockTotals(product);
  },

  async createProduct(dto: CreateProductDto, currency: string) {
    const skus = dto.variants.map((v) => v.sku);
    const dupSku = await prisma.productVariant.findFirst({
      where: { sku: { in: skus }, deletedAt: null },
    });
    if (dupSku) throw new ConflictError(`SKU "${dupSku.sku}" is already in use`);

    const slug = await uniqueSlug('product', dto.name);
    const hasDefault = dto.variants.some((v) => v.isDefault);

    const product = await prisma.product.create({
      data: {
        name: dto.name,
        slug,
        description: dto.description ?? null,
        categoryId: dto.categoryId ?? null,
        brandId: dto.brandId ?? null,
        status: dto.status,
        taxRate: dto.taxRate,
        variants: {
          create: dto.variants.map((v, i) => ({
            organizationId: orgId(),
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
          })),
        },
      },
      select: productSelect,
    });
    return withStockTotals(product);
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
    return withStockTotals(product);
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
    return prisma.productVariant.create({
      data: {
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
      },
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
    return prisma.productVariant.update({
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
      },
    });
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
      data: { name, slug: await uniqueSlug('productCategory', name), parentId: parentId ?? null },
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
      data: { name, slug: await uniqueSlug('brand', name) },
    });
  },

  async deleteBrand(id: string) {
    const inUse = await prisma.product.count({ where: { brandId: id, deletedAt: null } });
    if (inUse > 0) throw new ConflictError('Brand has products — reassign them first');
    await prisma.brand.update({ where: { id }, data: { deletedAt: new Date() } });
  },
};
