import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { applyMovement } from './stock-ledger';

/**
 * Materials leaving a store for a production line.
 *
 * Issuing and consuming are separate on purpose (§10). Stock that has been
 * issued has left the shelf but may come back unused; stock that has been
 * consumed is gone into the product. A business that records only one of them
 * cannot explain its variance, because "we took out 500kg" and "we used 500kg"
 * are different claims and only the second belongs in a yield calculation.
 *
 * Both are atomic (§32): the balance, the movement, the running total on the
 * order and the audit entry commit together or not at all.
 */

export const issueMaterialSchema = z.object({
  warehouseId: z.string().min(1),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.coerce.number().positive(),
        /** Which lot came off the shelf, for tracing the finished batch back. */
        batchId: z.string().min(1).nullable().optional(),
        batchNumber: z.string().trim().max(80).nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .min(1),
  /**
   * Supplied by the caller and unique per issue. A retried request that
   * arrives twice must not take the sugar out twice (§32).
   */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const consumeMaterialSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        /** What was really used. May be less than issued — the rest returns. */
        quantity: z.coerce.number().positive(),
      }),
    )
    .min(1),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const returnMaterialSchema = z.object({
  warehouseId: z.string().min(1),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.coerce.number().positive(),
        batchNumber: z.string().trim().max(80).nullable().optional(),
      }),
    )
    .min(1),
  reason: z.string().trim().max(300).nullable().optional(),
});

export const materialConsumptionService = {
  /**
   * Hand materials to a production line.
   *
   * Stock leaves the store here — this is the moment inventory drops, not when
   * the order was raised. Refuses to issue against an order that has not been
   * started: material sitting on a line for a run nobody has begun is how it
   * goes missing.
   */
  async issue(
    productionOrderId: string,
    dto: z.infer<typeof issueMaterialSchema>,
    actorUserId: string,
  ) {
    const order = await loadOrder(productionOrderId);
    if (!['APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED'].includes(order.status)) {
      throw new ValidationError(
        `Materials cannot be issued to a ${order.status.toLowerCase()} production order.`,
      );
    }

    // Checked before anything moves, so a repeat of the same request is a
    // no-op rather than a second withdrawal.
    if (dto.idempotencyKey) {
      const seen = await prisma.materialConsumption.findFirst({
        where: { productionOrderId, notes: { contains: dto.idempotencyKey } },
        select: { id: true },
      });
      if (seen) {
        return { alreadyIssued: true, productionOrderId, issued: [] as IssuedLine[] };
      }
    }

    const warehouse = await prisma.warehouse.findFirst({
      where: { id: dto.warehouseId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!warehouse) throw new NotFoundError('Warehouse');

    const issued = await prisma.$transaction(async (tx) => {
      const lines: IssuedLine[] = [];
      for (const item of dto.items) {
        const material = order.materials.find((m) => m.variantId === item.variantId);
        if (!material) {
          throw new ValidationError(
            'That material is not on this production order, so issuing it would not be tracked against anything.',
          );
        }

        // Stock out. Throws — and rolls the whole issue back — if the store
        // cannot cover it.
        await applyMovement(tx, {
          organizationId: order.organizationId,
          warehouseId: dto.warehouseId,
          variantId: item.variantId,
          quantityChange: -item.quantity,
          type: 'MATERIAL_ISSUE',
          referenceType: 'PRODUCTION_ORDER',
          referenceId: productionOrderId,
          reason: dto.notes ?? null,
          batchNumber: item.batchNumber ?? null,
          actorUserId,
        });

        await tx.materialConsumption.create({
          data: {
            organizationId: order.organizationId,
            productionOrderId,
            warehouseId: dto.warehouseId,
            variantId: item.variantId,
            requiredQuantity: material.requiredQuantity,
            issuedQuantity: item.quantity,
            batchId: item.batchId ?? null,
            batchNumber: item.batchNumber ?? null,
            issuedByUserId: actorUserId,
            notes: [item.notes, dto.notes, dto.idempotencyKey].filter(Boolean).join(' · ') || null,
          },
        });

        const updated = await tx.productionMaterial.update({
          where: { id: material.id },
          data: { issuedQuantity: { increment: item.quantity } },
          select: { requiredQuantity: true, issuedQuantity: true },
        });

        lines.push({
          variantId: item.variantId,
          quantity: item.quantity,
          required: Number(updated.requiredQuantity),
          issuedTotal: Number(updated.issuedQuantity),
        });
      }
      return lines;
    });

    await auditService
      .record({
        action: 'production.material_issued',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: {
          warehouse: warehouse.name,
          lines: issued.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        },
        reason: dto.notes ?? null,
      })
      .catch(() => {});

    return { alreadyIssued: false, productionOrderId, issued };
  },

  /**
   * Record what was actually used.
   *
   * No stock moves here — it already left the store when it was issued. This
   * is the number the yield and variance calculations read, which is why it is
   * recorded separately rather than assumed equal to what went out.
   */
  async consume(
    productionOrderId: string,
    dto: z.infer<typeof consumeMaterialSchema>,
    actorUserId: string,
  ) {
    const order = await loadOrder(productionOrderId);
    if (!['IN_PROGRESS', 'PAUSED'].includes(order.status)) {
      throw new ValidationError(
        'Consumption can only be recorded against a run that has started.',
      );
    }

    const consumed = await prisma.$transaction(async (tx) => {
      const lines: { variantId: string; quantity: number; consumedTotal: number; issuedTotal: number }[] = [];
      for (const item of dto.items) {
        const material = order.materials.find((m) => m.variantId === item.variantId);
        if (!material) {
          throw new ValidationError('That material is not on this production order.');
        }
        const consumedAfter = Number(material.consumedQuantity) + item.quantity;
        // Using more than left the store means something is unrecorded — an
        // issue that was never entered, or a number typed wrong. Either way it
        // is worth stopping on rather than producing an impossible variance.
        if (consumedAfter > Number(material.issuedQuantity) + 1e-6) {
          throw new ValidationError(
            `More has been consumed than was issued for ${material.variant.sku} ` +
              `(${consumedAfter} used, ${Number(material.issuedQuantity)} issued). ` +
              'Issue the difference first, so the movement is on record.',
          );
        }

        const updated = await tx.productionMaterial.update({
          where: { id: material.id },
          data: { consumedQuantity: { increment: item.quantity } },
          select: { consumedQuantity: true, issuedQuantity: true },
        });
        await tx.materialConsumption.create({
          data: {
            organizationId: order.organizationId,
            productionOrderId,
            warehouseId: order.warehouseId ?? material.fallbackWarehouseId,
            variantId: item.variantId,
            requiredQuantity: material.requiredQuantity,
            consumedQuantity: item.quantity,
            issuedByUserId: actorUserId,
            notes: dto.notes ?? null,
          },
        });
        lines.push({
          variantId: item.variantId,
          quantity: item.quantity,
          consumedTotal: Number(updated.consumedQuantity),
          issuedTotal: Number(updated.issuedQuantity),
        });
      }
      return lines;
    });

    await auditService
      .record({
        action: 'production.material_consumed',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: { lines: consumed.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) },
        reason: dto.notes ?? null,
      })
      .catch(() => {});
    return { productionOrderId, consumed };
  },

  /** Unused material going back to the store. */
  async returnToStore(
    productionOrderId: string,
    dto: z.infer<typeof returnMaterialSchema>,
    actorUserId: string,
  ) {
    const order = await loadOrder(productionOrderId);

    const returned = await prisma.$transaction(async (tx) => {
      const lines: { variantId: string; quantity: number }[] = [];
      for (const item of dto.items) {
        const material = order.materials.find((m) => m.variantId === item.variantId);
        if (!material) throw new ValidationError('That material is not on this production order.');

        const outstanding = Number(material.issuedQuantity) - Number(material.consumedQuantity);
        if (item.quantity > outstanding + 1e-6) {
          throw new ValidationError(
            `Only ${outstanding} of ${material.variant.sku} is out on the line to return.`,
          );
        }

        await applyMovement(tx, {
          organizationId: order.organizationId,
          warehouseId: dto.warehouseId,
          variantId: item.variantId,
          quantityChange: item.quantity,
          type: 'MATERIAL_RETURN',
          referenceType: 'PRODUCTION_ORDER',
          referenceId: productionOrderId,
          reason: dto.reason ?? null,
          batchNumber: item.batchNumber ?? null,
          actorUserId,
        });
        await tx.productionMaterial.update({
          where: { id: material.id },
          data: { issuedQuantity: { decrement: item.quantity } },
        });
        lines.push({ variantId: item.variantId, quantity: item.quantity });
      }
      return lines;
    });

    await auditService
      .record({
        action: 'production.material_returned',
        entityType: 'PRODUCTION_ORDER',
        entityId: productionOrderId,
        after: { lines: returned },
        reason: dto.reason ?? null,
      })
      .catch(() => {});
    return { productionOrderId, returned };
  },

  /** Everything that has moved for one order, newest first. */
  async history(productionOrderId: string) {
    return prisma.materialConsumption.findMany({
      where: { productionOrderId },
      orderBy: { occurredAt: 'desc' },
      select: {
        id: true, issuedQuantity: true, consumedQuantity: true, requiredQuantity: true,
        batchNumber: true, occurredAt: true, notes: true, issuedByUserId: true,
        warehouse: { select: { id: true, name: true } },
        variant: { select: { id: true, sku: true, product: { select: { name: true, unit: true } } } },
      },
    });
  },
};

interface IssuedLine {
  variantId: string;
  quantity: number;
  required: number;
  issuedTotal: number;
}

async function loadOrder(id: string) {
  const order = await prisma.productionOrder.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, organizationId: true, status: true, orderNumber: true, warehouseId: true,
      materials: {
        select: {
          id: true, variantId: true, requiredQuantity: true,
          issuedQuantity: true, consumedQuantity: true,
          variant: { select: { sku: true } },
        },
      },
    },
  });
  if (!order) throw new NotFoundError('Production order');
  return {
    ...order,
    materials: order.materials.map((m) => ({ ...m, fallbackWarehouseId: order.warehouseId ?? '' })),
  };
}
