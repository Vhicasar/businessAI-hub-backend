import type { StockMovementType } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { ValidationError } from '../../shared/errors';

/**
 * The one way manufacturing moves stock.
 *
 * Every material issued, consumed, returned, produced, quarantined or fitted
 * to a machine goes through here, inside the caller's transaction. Two reasons
 * it is not done inline at each call site:
 *
 *  - §19: a quantity must never change without an auditable movement beside
 *    it. Written once, that is a property of the code rather than a rule
 *    everybody has to remember.
 *  - §32: the balance and the movement have to commit or fail together. Taking
 *    a transaction handle rather than opening its own is what lets a caller
 *    wrap "check, move, link, record" into a single atomic step.
 *
 * Deliberately mirrors what `inventory.service` already does for adjustments
 * and transfers — same upsert, same guards — so manufacturing stock is the
 * same stock, not a parallel ledger that drifts.
 */

/**
 * The client available inside a transaction.
 *
 * Derived from the tenant-scoped client rather than named as
 * `Prisma.TransactionClient`: the org-injecting `$extends` produces its own
 * transaction type, and the two are not interchangeable to the compiler.
 */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface LedgerEntry {
  organizationId: string;
  warehouseId: string;
  variantId: string;
  /** Signed: negative takes stock out, positive puts it in. */
  quantityChange: number;
  type: StockMovementType;
  /** What caused this — PRODUCTION_ORDER, MAINTENANCE, QC… */
  referenceType: string;
  referenceId?: string | null;
  reason?: string | null;
  batchNumber?: string | null;
  expiryDate?: Date | null;
  actorUserId?: string | null;
}

/**
 * Apply one movement and return the resulting balance.
 *
 * Refuses to go negative, and refuses to eat into what is already reserved for
 * someone else — the same two rules stock adjustments have always followed.
 * A production run that would overdraw a store is a planning problem, and it
 * should surface as one rather than as a negative number nobody notices.
 */
export async function applyMovement(tx: Tx, entry: LedgerEntry): Promise<number> {
  const level = await tx.stockLevel.upsert({
    where: {
      warehouseId_variantId: { warehouseId: entry.warehouseId, variantId: entry.variantId },
    },
    update: {},
    create: {
      organizationId: entry.organizationId,
      warehouseId: entry.warehouseId,
      variantId: entry.variantId,
      quantity: 0,
    },
  });

  const current = Number(level.quantity);
  const next = current + entry.quantityChange;

  if (next < 0) {
    const variant = await tx.productVariant.findUnique({
      where: { id: entry.variantId },
      select: { sku: true, product: { select: { name: true } } },
    });
    const label = variant ? `${variant.product.name} (${variant.sku})` : 'This material';
    throw new ValidationError(
      `${label} would go below zero — ${current} available, ${Math.abs(entry.quantityChange)} needed.`,
    );
  }
  if (next < Number(level.reserved)) {
    throw new ValidationError(
      `That would take stock below what is already reserved (${Number(level.reserved)}).`,
    );
  }

  await tx.stockLevel.update({ where: { id: level.id }, data: { quantity: next } });
  await tx.stockMovement.create({
    data: {
      organizationId: entry.organizationId,
      warehouseId: entry.warehouseId,
      variantId: entry.variantId,
      type: entry.type,
      quantity: entry.quantityChange,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId ?? null,
      reason: entry.reason ?? null,
      batchNumber: entry.batchNumber ?? null,
      expiryDate: entry.expiryDate ?? null,
      actorUserId: entry.actorUserId ?? null,
    },
  });
  return next;
}

/**
 * What is actually usable in a warehouse right now.
 *
 * Reserved stock is excluded: it is spoken for, and planning a production run
 * against it is how two people end up promised the same sugar.
 */
export async function availableIn(
  tx: Tx,
  warehouseId: string,
  variantId: string,
): Promise<{ quantity: number; reserved: number; available: number }> {
  const level = await tx.stockLevel.findUnique({
    where: { warehouseId_variantId: { warehouseId, variantId } },
    select: { quantity: true, reserved: true },
  });
  const quantity = Number(level?.quantity ?? 0);
  const reserved = Number(level?.reserved ?? 0);
  return { quantity, reserved, available: quantity - reserved };
}
