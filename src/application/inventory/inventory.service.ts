import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';

export const warehouseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  city: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const adjustStockSchema = z.object({
  variantId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantityChange: z.coerce.number().refine((n) => n !== 0, 'Change cannot be zero'),
  reason: z.string().trim().max(300).optional(),
});

export const listStockSchema = z.object({
  warehouseId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  lowStockOnly: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type WarehouseDto = z.infer<typeof warehouseSchema>;
export type AdjustStockDto = z.infer<typeof adjustStockSchema>;
export type ListStockDto = z.infer<typeof listStockSchema>;

export const inventoryService = {
  async listWarehouses() {
    return prisma.warehouse.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, code: true, city: true, country: true, isDefault: true, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  },

  /** Returns the default warehouse, creating "Main Warehouse" on first use. */
  async ensureDefaultWarehouse() {
    const existing = await prisma.warehouse.findFirst({
      where: { deletedAt: null, isActive: true },
      orderBy: { isDefault: 'desc' },
    });
    if (existing) return existing;
    return prisma.warehouse.create({
      data: { name: 'Main Warehouse', code: 'MAIN', isDefault: true },
    });
  },

  async createWarehouse(dto: WarehouseDto) {
    const dup = await prisma.warehouse.findFirst({ where: { code: dto.code, deletedAt: null } });
    if (dup) throw new ConflictError(`Warehouse code "${dto.code}" already exists`);
    if (dto.isDefault) {
      await prisma.warehouse.updateMany({ where: {}, data: { isDefault: false } });
    }
    return prisma.warehouse.create({
      data: {
        name: dto.name,
        code: dto.code,
        city: dto.city ?? null,
        country: dto.country ?? null,
        isDefault: dto.isDefault ?? false,
      },
    });
  },

  async listStock(dto: ListStockDto) {
    const rows = await prisma.stockLevel.findMany({
      where: {
        ...(dto.warehouseId ? { warehouseId: dto.warehouseId } : {}),
        variant: {
          deletedAt: null,
          ...(dto.search
            ? {
                OR: [
                  { sku: { contains: dto.search, mode: 'insensitive' as const } },
                  { product: { name: { contains: dto.search, mode: 'insensitive' as const } } },
                ],
              }
            : {}),
        },
      },
      select: {
        id: true,
        quantity: true,
        reserved: true,
        reorderPoint: true,
        warehouse: { select: { id: true, name: true, code: true } },
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
            price: true,
            product: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    let items = rows.map((r) => ({
      ...r,
      available: Number(r.quantity) - Number(r.reserved),
    }));
    if (dto.lowStockOnly) {
      items = items.filter(
        (r) => r.reorderPoint !== null && r.available <= Number(r.reorderPoint)
      );
    }
    const hasMore = rows.length > dto.limit;
    return {
      items: hasMore ? items.slice(0, dto.limit) : items,
      nextCursor: hasMore ? rows[dto.limit - 1]?.id ?? null : null,
    };
  },

  async adjustStock(dto: AdjustStockDto, actorUserId: string) {
    const [variant, warehouse] = await Promise.all([
      prisma.productVariant.findFirst({ where: { id: dto.variantId, deletedAt: null } }),
      prisma.warehouse.findFirst({ where: { id: dto.warehouseId, deletedAt: null } }),
    ]);
    if (!variant) throw new NotFoundError('Variant');
    if (!warehouse) throw new NotFoundError('Warehouse');

    return prisma.$transaction(async (tx) => {
      const level = await tx.stockLevel.upsert({
        where: {
          warehouseId_variantId: { warehouseId: dto.warehouseId, variantId: dto.variantId },
        },
        update: {},
        create: {
          organizationId: variant.organizationId,
          warehouseId: dto.warehouseId,
          variantId: dto.variantId,
          quantity: 0,
        },
      });

      const newQty = Number(level.quantity) + dto.quantityChange;
      if (newQty < 0) {
        throw new ValidationError(
          `Adjustment would make stock negative (current ${Number(level.quantity)})`
        );
      }
      if (newQty < Number(level.reserved)) {
        throw new ValidationError(
          `Cannot reduce below reserved quantity (${Number(level.reserved)})`
        );
      }

      const updated = await tx.stockLevel.update({
        where: { id: level.id },
        data: { quantity: newQty },
      });

      await tx.stockMovement.create({
        data: {
          organizationId: variant.organizationId,
          warehouseId: dto.warehouseId,
          variantId: dto.variantId,
          type: 'ADJUSTMENT',
          quantity: dto.quantityChange,
          reason: dto.reason ?? null,
          actorUserId,
          referenceType: 'ADJUSTMENT',
        },
      });

      return updated;
    });
  },
};
