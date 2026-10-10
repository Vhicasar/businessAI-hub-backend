import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';

export interface AllocationRequirement { materialId: string; variantId: string; requiredQuantity: number }
export interface WarehouseBalance { warehouseId: string; variantId: string; available: number }
export interface MaterialAllocationResult {
  materialId: string;
  variantId: string;
  requiredQuantity: number;
  availableQuantity: number;
  shortageQuantity: number;
  allocations: Array<{ warehouseId: string; quantity: number; batchId: string | null }>;
}

/** Deterministic, explainable allocation: preferred first, then largest balance. */
export function allocateBalances(
  requirements: AllocationRequirement[],
  balances: WarehouseBalance[],
  preferredWarehouseId?: string | null,
): MaterialAllocationResult[] {
  return requirements.map((requirement) => {
    let remaining = requirement.requiredQuantity;
    const candidates = balances
      .filter((row) => row.variantId === requirement.variantId && row.available > 0)
      .sort((a, b) => {
        const ap = a.warehouseId === preferredWarehouseId ? 1 : 0;
        const bp = b.warehouseId === preferredWarehouseId ? 1 : 0;
        return bp - ap || b.available - a.available || a.warehouseId.localeCompare(b.warehouseId);
      });
    const allocations: MaterialAllocationResult['allocations'] = [];
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const quantity = round3(Math.min(remaining, candidate.available));
      if (quantity > 0) allocations.push({ warehouseId: candidate.warehouseId, quantity, batchId: null });
      remaining = round3(remaining - quantity);
    }
    const availableQuantity = round3(requirement.requiredQuantity - Math.max(0, remaining));
    return {
      ...requirement,
      availableQuantity,
      shortageQuantity: round3(Math.max(0, remaining)),
      allocations,
    };
  });
}

export const materialAllocationService = {
  async forOrder(productionOrderId: string): Promise<MaterialAllocationResult[]> {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: {
        id: true, warehouseId: true,
        materials: { select: { id: true, variantId: true, requiredQuantity: true } },
      },
    });
    if (!order) throw new NotFoundError('Production order');
    const variantIds = order.materials.map((item) => item.variantId);
    const levels = await prisma.stockLevel.findMany({
      where: { variantId: { in: variantIds }, warehouse: { isActive: true, deletedAt: null } },
      select: { warehouseId: true, variantId: true, quantity: true, reserved: true },
    });
    return allocateBalances(
      order.materials.map((item) => ({ materialId: item.id, variantId: item.variantId, requiredQuantity: Number(item.requiredQuantity) })),
      levels.map((level) => ({ warehouseId: level.warehouseId, variantId: level.variantId, available: Math.max(0, Number(level.quantity) - Number(level.reserved)) })),
      order.warehouseId,
    );
  },

  async validateOverrides(productionOrderId: string, overrides: Array<{ materialId: string; warehouseId: string; quantity: number; batchId?: string | null }>): Promise<MaterialAllocationResult[]> {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: { materials: { select: { id: true, variantId: true, requiredQuantity: true } } },
    });
    if (!order) throw new NotFoundError('Production order');
    const materialById = new Map(order.materials.map((m) => [m.id, m]));
    const seen = new Set<string>();
    for (const row of overrides) {
      if (!materialById.has(row.materialId)) throw new ValidationError('An allocation does not belong to this production order.');
      const key = `${row.materialId}:${row.warehouseId}:${row.batchId ?? ''}`;
      if (seen.has(key)) throw new ValidationError('Combine duplicate allocations for the same material and warehouse.');
      seen.add(key);
    }
    const warehouseIds = [...new Set(overrides.map((row) => row.warehouseId))];
    const warehouses = await prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, isActive: true, deletedAt: null }, select: { id: true } });
    if (warehouses.length !== warehouseIds.length) throw new ValidationError('An allocation uses an unavailable warehouse.');
    const levels = await prisma.stockLevel.findMany({
      where: { warehouseId: { in: warehouseIds }, variantId: { in: order.materials.map((m) => m.variantId) } },
      select: { warehouseId: true, variantId: true, quantity: true, reserved: true },
    });
    const available = new Map(levels.map((l) => [`${l.warehouseId}:${l.variantId}`, Math.max(0, Number(l.quantity) - Number(l.reserved))]));
    return order.materials.map((material) => {
      const rows = overrides.filter((row) => row.materialId === material.id);
      const required = Number(material.requiredQuantity);
      const total = round3(rows.reduce((sum, row) => sum + row.quantity, 0));
      if (total > required + 1e-6) throw new ValidationError('Allocated quantity cannot exceed the material requirement.');
      for (const row of rows) {
        const balance = available.get(`${row.warehouseId}:${material.variantId}`) ?? 0;
        if (row.quantity > balance + 1e-6) throw new ValidationError(`An allocation exceeds the available unreserved stock (${balance}).`);
      }
      return {
        materialId: material.id, variantId: material.variantId, requiredQuantity: required,
        availableQuantity: total, shortageQuantity: round3(required - total),
        allocations: rows.map((row) => ({ warehouseId: row.warehouseId, quantity: round3(row.quantity), batchId: row.batchId ?? null })),
      };
    });
  },
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
