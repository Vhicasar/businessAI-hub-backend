import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

export const warehouseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  managerId: z.string().min(1).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(30).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  isDefault: z.boolean().optional(),
});
export const updateWarehouseSchema = warehouseSchema.partial();

export const transferSchema = z.object({
  fromWarehouseId: z.string().min(1),
  toWarehouseId: z.string().min(1),
  notes: z.string().trim().max(1000).optional(),
  items: z
    .array(z.object({ variantId: z.string().min(1), quantity: z.coerce.number().positive() }))
    .min(1),
});

export const listMovementsSchema = z.object({
  warehouseId: z.string().optional(),
  variantId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const adjustStockSchema = z.object({
  variantId: z.string().min(1),
  // Optional: defaults to the org's default warehouse (auto-created on first use).
  warehouseId: z.string().min(1).optional(),
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
export type UpdateWarehouseDto = z.infer<typeof updateWarehouseSchema>;
export type TransferDto = z.infer<typeof transferSchema>;
export type ListMovementsDto = z.infer<typeof listMovementsSchema>;
export type AdjustStockDto = z.infer<typeof adjustStockSchema>;
export type ListStockDto = z.infer<typeof listStockSchema>;

export const inventoryService = {
  async listWarehouses() {
    return prisma.warehouse.findMany({
      where: { deletedAt: null },
      select: {
        id: true, name: true, code: true, managerId: true,
        addressLine1: true, addressLine2: true, city: true, state: true,
        postalCode: true, country: true, phone: true, isDefault: true, isActive: true,
        _count: { select: { stockLevels: true } },
      },
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
      data: { organizationId: currentOrgId(), name: 'Main Warehouse', code: 'MAIN', isDefault: true },
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
        organizationId: currentOrgId(),
        name: dto.name,
        code: dto.code,
        managerId: dto.managerId ?? null,
        addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        postalCode: dto.postalCode ?? null,
        country: dto.country ?? null,
        phone: dto.phone ?? null,
        isDefault: dto.isDefault ?? false,
      },
    });
  },

  async updateWarehouse(id: string, dto: UpdateWarehouseDto) {
    const wh = await prisma.warehouse.findFirst({ where: { id, deletedAt: null } });
    if (!wh) throw new NotFoundError('Warehouse');
    if (dto.code && dto.code !== wh.code) {
      const dup = await prisma.warehouse.findFirst({ where: { code: dto.code, deletedAt: null, id: { not: id } } });
      if (dup) throw new ConflictError(`Warehouse code "${dto.code}" already exists`);
    }
    if (dto.isDefault) {
      await prisma.warehouse.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    }
    return prisma.warehouse.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.managerId !== undefined ? { managerId: dto.managerId } : {}),
        ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
        ...(dto.addressLine2 !== undefined ? { addressLine2: dto.addressLine2 } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.state !== undefined ? { state: dto.state } : {}),
        ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
        ...(dto.country !== undefined ? { country: dto.country } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
      },
    });
  },

  /** Archive/unarchive a warehouse (kept for history; can't archive the default). */
  async setWarehouseActive(id: string, isActive: boolean) {
    const wh = await prisma.warehouse.findFirst({ where: { id, deletedAt: null } });
    if (!wh) throw new NotFoundError('Warehouse');
    if (!isActive && wh.isDefault) throw new ValidationError('Set another warehouse as default before archiving this one');
    return prisma.warehouse.update({ where: { id }, data: { isActive } });
  },

  async deleteWarehouse(id: string) {
    const wh = await prisma.warehouse.findFirst({ where: { id, deletedAt: null } });
    if (!wh) throw new NotFoundError('Warehouse');
    if (wh.isDefault) throw new ValidationError('Cannot delete the default warehouse');
    const remaining = await prisma.warehouse.count({ where: { deletedAt: null } });
    if (remaining <= 1) throw new ValidationError('At least one warehouse is required');
    const held = await prisma.stockLevel.aggregate({ where: { warehouseId: id }, _sum: { quantity: true } });
    if (Number(held._sum.quantity ?? 0) > 0) {
      throw new ValidationError('This warehouse still holds stock — transfer it out before deleting');
    }
    return prisma.warehouse.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
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
    const variant = await prisma.productVariant.findFirst({
      where: { id: dto.variantId, deletedAt: null },
    });
    if (!variant) throw new NotFoundError('Variant');

    const warehouse = dto.warehouseId
      ? await prisma.warehouse.findFirst({ where: { id: dto.warehouseId, deletedAt: null } })
      : await this.ensureDefaultWarehouse();
    if (!warehouse) throw new NotFoundError('Warehouse');
    const warehouseId = warehouse.id;

    return prisma.$transaction(async (tx) => {
      const level = await tx.stockLevel.upsert({
        where: {
          warehouseId_variantId: { warehouseId, variantId: dto.variantId },
        },
        update: {},
        create: {
          organizationId: variant.organizationId,
          warehouseId,
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
          warehouseId,
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

  // ── Transfers ────────────────────────────────────────────────────────────
  async listTransfers(limit = 50) {
    return prisma.stockTransfer.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, number: true, status: true, notes: true, createdAt: true,
        fromWarehouse: { select: { id: true, name: true, code: true } },
        toWarehouse: { select: { id: true, name: true, code: true } },
        items: { select: { variantId: true, quantity: true } },
      },
    });
  },

  /**
   * Move stock between warehouses in one atomic step: decrement the source,
   * increment the destination, log a TRANSFER_OUT/TRANSFER_IN movement per item,
   * and record the transfer (received immediately). Refuses to move more than is
   * actually available (quantity minus what's already reserved).
   */
  async createTransfer(dto: TransferDto, actorUserId: string | null) {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new ValidationError('Source and destination warehouses must differ');
    }
    const [from, to] = await Promise.all([
      prisma.warehouse.findFirst({ where: { id: dto.fromWarehouseId, deletedAt: null } }),
      prisma.warehouse.findFirst({ where: { id: dto.toWarehouseId, deletedAt: null } }),
    ]);
    if (!from) throw new NotFoundError('Source warehouse');
    if (!to) throw new NotFoundError('Destination warehouse');
    const organizationId = from.organizationId;

    return prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        const src = await tx.stockLevel.findUnique({
          where: { warehouseId_variantId: { warehouseId: from.id, variantId: item.variantId } },
        });
        const available = src ? Number(src.quantity) - Number(src.reserved) : 0;
        if (available < item.quantity) {
          throw new ValidationError(
            `Not enough available stock at ${from.name} (available ${available}, requested ${item.quantity})`
          );
        }
        await tx.stockLevel.update({ where: { id: src!.id }, data: { quantity: { decrement: item.quantity } } });
        await tx.stockLevel.upsert({
          where: { warehouseId_variantId: { warehouseId: to.id, variantId: item.variantId } },
          create: { organizationId, warehouseId: to.id, variantId: item.variantId, quantity: item.quantity },
          update: { quantity: { increment: item.quantity } },
        });
        await tx.stockMovement.createMany({
          data: [
            { organizationId, warehouseId: from.id, variantId: item.variantId, type: 'TRANSFER_OUT', quantity: -item.quantity, referenceType: 'TRANSFER', reason: dto.notes ?? null, actorUserId },
            { organizationId, warehouseId: to.id, variantId: item.variantId, type: 'TRANSFER_IN', quantity: item.quantity, referenceType: 'TRANSFER', reason: dto.notes ?? null, actorUserId },
          ],
        });
      }
      const count = await tx.stockTransfer.count();
      const number = `TRF-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
      return tx.stockTransfer.create({
        data: {
          organizationId,
          number,
          fromWarehouseId: from.id,
          toWarehouseId: to.id,
          status: 'RECEIVED',
          notes: dto.notes ?? null,
          createdById: actorUserId,
          shippedAt: new Date(),
          receivedAt: new Date(),
          items: { create: dto.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, receivedQty: i.quantity })) },
        },
        select: { id: true, number: true, status: true, fromWarehouseId: true, toWarehouseId: true, createdAt: true },
      });
    });
  },

  // ── Movements (per-warehouse audit / report) ─────────────────────────────
  async listMovements(dto: ListMovementsDto) {
    return prisma.stockMovement.findMany({
      where: {
        ...(dto.warehouseId ? { warehouseId: dto.warehouseId } : {}),
        ...(dto.variantId ? { variantId: dto.variantId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: dto.limit,
      select: {
        id: true, type: true, quantity: true, referenceType: true, reason: true, createdAt: true,
        warehouse: { select: { id: true, name: true, code: true } },
        variant: { select: { id: true, name: true, sku: true, product: { select: { name: true } } } },
      },
    });
  },
};
