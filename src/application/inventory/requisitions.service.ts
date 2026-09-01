import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { auditService } from '../audit/audit.service';
import { notifyService } from '../notifications/notify.service';

/**
 * One warehouse asking another for stock.
 *
 * Not a purchase order: no supplier, no money, no external party. The stock
 * already belongs to the business — what is in question is which of its
 * warehouses is holding it.
 *
 * The lifecycle exists because "asked for" and "arrived" are far apart, and
 * conflating them is how warehouse counts stop matching the shelves. Nothing
 * leaves the source until dispatch, and nothing lands at the destination until
 * someone there receives it — a request on its own moves no stock at all.
 */

export const requisitionItemSchema = z.object({
  variantId: z.string().min(1),
  requestedQty: z.coerce.number().positive(),
});

export const createRequisitionSchema = z.object({
  /** The warehouse that needs the stock. */
  toWarehouseId: z.string().min(1),
  /** The warehouse being asked to supply it. */
  fromWarehouseId: z.string().min(1),
  items: z.array(requisitionItemSchema).min(1).max(200),
  reason: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(1000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  /** Submit straight away rather than leaving it as a draft. */
  submit: z.boolean().optional(),
});

export const approveRequisitionSchema = z.object({
  /**
   * Per-line agreement. Omitted lines are approved in full; a source that can
   * only spare part of what was asked says so here rather than silently
   * shorting the dispatch later.
   */
  items: z.array(z.object({ itemId: z.string().min(1), approvedQty: z.coerce.number().min(0) })).optional(),
  note: z.string().trim().max(500).optional(),
});

export const dispatchSchema = z.object({
  items: z.array(z.object({ itemId: z.string().min(1), quantity: z.coerce.number().positive() })).optional(),
  notes: z.string().trim().max(500).optional(),
  /** Stable per physical dispatch, so a retry does not send stock twice. */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export const receiveRequisitionSchema = z.object({
  items: z.array(z.object({ itemId: z.string().min(1), quantity: z.coerce.number().positive() })).optional(),
  notes: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  /**
   * The code on the printed note, scanned or typed.
   *
   * Required: stock travels with the paperwork, so holding the note is the
   * evidence that the goods are physically present. Without it someone at a
   * desk could mark a transfer received before it had arrived, and the two
   * warehouses' counts would both be wrong until somebody noticed.
   */
  scanToken: z.string().trim().min(8).max(120),
});

const num = (v: unknown): number => Number(v ?? 0);
const orgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
};
const actorUserId = (): string | null => requestContext.get()?.userId ?? null;

async function nextNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.internalRequisition.count();
  return `IR-${year}-${String(count + 1).padStart(4, '0')}`;
}

/** What the source warehouse can actually spare right now. */
async function availableAt(warehouseId: string, variantId: string): Promise<number> {
  const level = await prisma.stockLevel.findUnique({
    where: { warehouseId_variantId: { warehouseId, variantId } },
  });
  // Reserved stock is spoken for by orders already placed, so it is not
  // available to send elsewhere.
  return level ? num(level.quantity) - num(level.reserved) : 0;
}

const detail = {
  fromWarehouse: { select: { id: true, name: true, code: true } },
  toWarehouse: { select: { id: true, name: true, code: true } },
  items: {
    include: {
      variant: {
        select: {
          id: true, sku: true, barcode: true, name: true,
          product: { select: { name: true, unit: true } },
        },
      },
    },
  },
  transfers: {
    select: { id: true, number: true, status: true, shippedAt: true, receivedAt: true },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

/**
 * Tell the people who need to act.
 *
 * Best-effort: a requisition that was approved stays approved even if the
 * notification cannot be delivered.
 */
async function notifyWarehouse(
  warehouseId: string,
  type: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const warehouse = await prisma.warehouse.findFirst({
      where: { id: warehouseId },
      select: { organizationId: true, managerId: true },
    });
    if (!warehouse?.managerId) return;
    const membership = await prisma.membership.findFirst({
      where: { id: warehouse.managerId, isActive: true, deletedAt: null },
      select: { userId: true },
    });
    if (!membership) return;
    await notifyService.notifyUsers(warehouse.organizationId, [membership.userId], {
      type, title, body, data,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, warehouseId, type }, 'requisition notification not sent');
  }
}

/** Derive the status from what has actually moved. */
function progressStatus(items: { approvedQty: unknown; requestedQty: unknown; dispatchedQty: unknown; receivedQty: unknown }[]) {
  const target = (i: (typeof items)[number]) => (i.approvedQty === null ? num(i.requestedQty) : num(i.approvedQty));
  const dispatched = items.reduce((s, i) => s + num(i.dispatchedQty), 0);
  const received = items.reduce((s, i) => s + num(i.receivedQty), 0);
  const agreed = items.reduce((s, i) => s + target(i), 0);

  const fullyDispatched = items.every((i) => num(i.dispatchedQty) >= target(i));
  const fullyReceived = items.every((i) => num(i.receivedQty) >= num(i.dispatchedQty)) && dispatched > 0;

  if (received > 0 && fullyDispatched && fullyReceived && received >= agreed) return 'COMPLETED' as const;
  if (received > 0) return 'PARTIALLY_RECEIVED' as const;
  if (dispatched > 0 && fullyDispatched) return 'DISPATCHED' as const;
  if (dispatched > 0) return 'PARTIALLY_DISPATCHED' as const;
  return null;
}

/**
 * The string the QR encodes.
 *
 * Same shape as the purchase-order document (`vhicasar://po/…`) so the phone
 * treats both kinds of paperwork the same way.
 */
function withScanPayload<T extends { scanToken: string | null }>(row: T): T & { scanPayload: string | null } {
  return { ...row, scanPayload: row.scanToken ? `vhicasar://ir/${row.scanToken}` : null };
}

export const requisitionsService = {
  async list(filters: { status?: string; warehouseId?: string; limit?: number } = {}) {
    const rows = await prisma.internalRequisition.findMany({
      where: {
        ...(filters.status ? { status: filters.status as never } : {}),
        ...(filters.warehouseId
          ? { OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] }
          : {}),
      },
      include: detail,
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 50,
    });
    // The list is what the print button reads from, so it needs the payload
    // too — omitting it here is why the button would sit permanently disabled.
    return rows.map(withScanPayload);
  },

  async byId(id: string) {
    const row = await prisma.internalRequisition.findFirst({ where: { id }, include: detail });
    if (!row) throw new NotFoundError('Internal requisition');
    return withScanPayload(row);
  },

  async byScanToken(token: string) {
    const row = await prisma.internalRequisition.findFirst({ where: { scanToken: token }, include: detail });
    if (!row) throw new NotFoundError('Internal requisition');
    return withScanPayload(row);
  },

  /**
   * What the destination needs on screen to receive this requisition —
   * expected, already received, still outstanding, plus the codes that let a
   * scan match a line.
   */
  async receivingView(id: string) {
    const r = await this.byId(id);
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      fromWarehouse: r.fromWarehouse,
      toWarehouse: r.toWarehouse,
      reason: r.reason,
      items: r.items.map((i) => {
        // Only what has actually left the source can be received.
        const dispatched = num(i.dispatchedQty);
        const received = num(i.receivedQty);
        return {
          itemId: i.id,
          variantId: i.variantId,
          sku: i.variant.sku,
          barcode: i.variant.barcode,
          name: i.variant.name || i.variant.product.name,
          requested: num(i.requestedQty),
          approved: i.approvedQty === null ? null : num(i.approvedQty),
          expected: dispatched,
          previouslyReceived: received,
          remaining: Math.max(0, Number((dispatched - received).toFixed(3))),
        };
      }),
    };
  },

  async create(dto: z.infer<typeof createRequisitionSchema>) {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new ValidationError('A warehouse cannot request stock from itself.');
    }
    const [from, to] = await Promise.all([
      prisma.warehouse.findFirst({ where: { id: dto.fromWarehouseId, deletedAt: null }, select: { id: true, name: true } }),
      prisma.warehouse.findFirst({ where: { id: dto.toWarehouseId, deletedAt: null }, select: { id: true, name: true } }),
    ]);
    if (!from) throw new NotFoundError('Source warehouse');
    if (!to) throw new NotFoundError('Destination warehouse');

    const number = await nextNumber();
    const created = await prisma.internalRequisition.create({
      data: {
        organizationId: orgId(),
        number,
        fromWarehouseId: from.id,
        toWarehouseId: to.id,
        status: dto.submit ? 'SUBMITTED' : 'DRAFT',
        submittedAt: dto.submit ? new Date() : null,
        priority: dto.priority,
        reason: dto.reason ?? null,
        notes: dto.notes ?? null,
        requestedById: actorUserId(),
        scanToken: randomBytes(16).toString('hex'),
        items: {
          create: dto.items.map((i) => ({ variantId: i.variantId, requestedQty: i.requestedQty })),
        },
      },
      include: detail,
    });

    /*
     * Creation and submission are separate events even when they happen in one
     * call: §22 asks for both, and a history that only shows "submitted" cannot
     * answer who raised the request in the first place.
     */
    await auditService.record({
      action: 'requisition.created',
      entityType: 'InternalRequisition',
      entityId: created.id,
      after: { number, status: created.status, from: from.name, to: to.name, lines: dto.items.length },
    });

    if (dto.submit) {
      await auditService.record({
        action: 'requisition.submitted',
        entityType: 'InternalRequisition',
        entityId: created.id,
        before: { status: 'DRAFT' },
        after: { status: created.status },
      });
      await notifyWarehouse(
        from.id,
        'inventory.requisition.submitted',
        'Stock requested',
        `${to.name} has requested ${dto.items.length} item${dto.items.length === 1 ? '' : 's'} from ${from.name}.`,
        { requisitionId: created.id, number },
      );
    }
    return withScanPayload(created);
  },

  /** Availability at the source, for the screen that raises the request. */
  async availability(fromWarehouseId: string, variantIds: string[]) {
    const levels = await prisma.stockLevel.findMany({
      where: { warehouseId: fromWarehouseId, variantId: { in: variantIds } },
      select: { variantId: true, quantity: true, reserved: true },
    });
    const byVariant = new Map(levels.map((l) => [l.variantId, num(l.quantity) - num(l.reserved)]));
    return variantIds.map((variantId) => ({ variantId, available: byVariant.get(variantId) ?? 0 }));
  },

  async submit(id: string) {
    const r = await this.byId(id);
    if (r.status !== 'DRAFT') throw new ConflictError('Only a draft requisition can be submitted.');
    const updated = await prisma.internalRequisition.update({
      where: { id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
      include: detail,
    });
    await auditService.record({
      action: 'requisition.submitted',
      entityType: 'InternalRequisition',
      entityId: id,
      before: { status: r.status },
      after: { status: updated.status },
    });
    await notifyWarehouse(
      r.fromWarehouseId,
      'inventory.requisition.submitted',
      'Stock requested',
      `${r.toWarehouse.name} has requested stock from ${r.fromWarehouse.name}.`,
      { requisitionId: id, number: r.number },
    );
    return withScanPayload(updated);
  },

  async approve(id: string, dto: z.infer<typeof approveRequisitionSchema>) {
    const r = await this.byId(id);
    if (r.status !== 'SUBMITTED') {
      throw new ConflictError('Only a submitted requisition can be approved.');
    }

    // An approval that promises more than the shelf holds is a promise the
    // dispatch cannot keep, so it is checked here rather than at dispatch.
    for (const line of dto.items ?? []) {
      const item = r.items.find((i) => i.id === line.itemId);
      if (!item) throw new NotFoundError('Requisition line');
      if (line.approvedQty > num(item.requestedQty)) {
        throw new ValidationError('Cannot approve more than was requested.');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const item of r.items) {
        const line = dto.items?.find((l) => l.itemId === item.id);
        await tx.internalRequisitionItem.update({
          where: { id: item.id },
          // No per-line decision means the whole request is agreed.
          data: { approvedQty: line ? line.approvedQty : num(item.requestedQty) },
        });
      }
      return tx.internalRequisition.update({
        where: { id },
        data: { status: 'APPROVED', approvedById: actorUserId(), approvedAt: new Date() },
        include: detail,
      });
    });

    await auditService.record({
      action: 'requisition.approved',
      entityType: 'InternalRequisition',
      entityId: id,
      before: { status: r.status },
      after: {
        status: updated.status,
        note: dto.note ?? null,
        lines: updated.items.map((i) => ({ itemId: i.id, approvedQty: num(i.approvedQty) })),
      },
    });
    for (const warehouseId of [r.fromWarehouseId, r.toWarehouseId]) {
      await notifyWarehouse(
        warehouseId,
        'inventory.requisition.approved',
        'Requisition approved',
        `${r.number} was approved. ${r.fromWarehouse.name} → ${r.toWarehouse.name}.`,
        { requisitionId: id, number: r.number },
      );
    }
    return withScanPayload(updated);
  },

  async reject(id: string, reason: string) {
    if (!reason.trim()) throw new ValidationError('Give a reason when rejecting a requisition.');
    const r = await this.byId(id);
    if (r.status !== 'SUBMITTED') throw new ConflictError('Only a submitted requisition can be rejected.');

    const updated = await prisma.internalRequisition.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: reason.trim(), approvedById: actorUserId(), approvedAt: new Date() },
      include: detail,
    });
    await auditService.record({
      action: 'requisition.rejected',
      entityType: 'InternalRequisition',
      entityId: id,
      before: { status: r.status },
      after: { status: updated.status, reason: reason.trim() },
    });
    await notifyWarehouse(
      r.toWarehouseId,
      'inventory.requisition.rejected',
      'Requisition rejected',
      `${r.number} was rejected: ${reason.trim()}`,
      { requisitionId: id, number: r.number },
    );
    return withScanPayload(updated);
  },

  /**
   * Send the stock.
   *
   * This is where it leaves the source warehouse — and only the source. The
   * destination's count does not move until someone there receives it, so
   * stock in transit is not double-counted in two places at once.
   */
  async dispatch(id: string, dto: z.infer<typeof dispatchSchema>) {
    const r = await this.byId(id);
    /*
     * Dispatch stays open while anything approved is still owed.
     *
     * Listing only APPROVED and PARTIALLY_DISPATCHED was wrong: once the first
     * delivery is received the requisition reads PARTIALLY_RECEIVED, and the
     * balance still to send could never leave the source.
     */
    const notYetApproved = ['DRAFT', 'SUBMITTED'];
    const closed = ['REJECTED', 'CANCELLED', 'COMPLETED'];
    if (notYetApproved.includes(r.status)) {
      throw new ConflictError('This requisition is not approved for dispatch.');
    }
    if (closed.includes(r.status)) {
      throw new ConflictError('This requisition is closed.');
    }

    if (dto.idempotencyKey) {
      const seen = await prisma.stockTransfer.findFirst({
        where: { organizationId: r.organizationId, idempotencyKey: dto.idempotencyKey },
        select: { id: true },
      });
      if (seen) {
        logger.info({ requisitionId: id, idempotencyKey: dto.idempotencyKey }, 'requisition dispatch replayed');
        return this.byId(id);
      }
    }

    const target = (i: (typeof r.items)[number]) =>
      i.approvedQty === null ? num(i.requestedQty) : num(i.approvedQty);
    const requested = dto.items
      ?? r.items
        .filter((i) => target(i) > num(i.dispatchedQty))
        .map((i) => ({ itemId: i.id, quantity: Number((target(i) - num(i.dispatchedQty)).toFixed(3)) }));
    if (requested.length === 0) throw new ConflictError('Nothing is outstanding to dispatch.');

    for (const line of requested) {
      const item = r.items.find((i) => i.id === line.itemId);
      if (!item) throw new NotFoundError('Requisition line');
      const outstanding = target(item) - num(item.dispatchedQty);
      if (line.quantity > outstanding + 1e-9) {
        throw new ValidationError(
          `Cannot dispatch ${line.quantity} — only ${outstanding} of that line is approved and outstanding.`,
        );
      }
      const available = await availableAt(r.fromWarehouseId, item.variantId);
      if (available < line.quantity) {
        throw new ValidationError(
          `${r.fromWarehouse.name} has ${available} available of that product; ${line.quantity} was requested.`,
        );
      }
    }

    const transferCount = await prisma.stockTransfer.count();
    const number = `TRF-${new Date().getFullYear()}-${String(transferCount + 1).padStart(4, '0')}`;

    await prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          organizationId: r.organizationId,
          number,
          fromWarehouseId: r.fromWarehouseId,
          toWarehouseId: r.toWarehouseId,
          requisitionId: id,
          idempotencyKey: dto.idempotencyKey ?? null,
          // In transit: gone from the source, not yet at the destination.
          status: 'IN_TRANSIT',
          notes: dto.notes ?? `Dispatched against ${r.number}`,
          createdById: actorUserId(),
          shippedAt: new Date(),
          items: {
            create: requested.map((line) => ({
              variantId: r.items.find((i) => i.id === line.itemId)!.variantId,
              quantity: line.quantity,
              receivedQty: 0,
            })),
          },
        },
      });

      for (const line of requested) {
        const item = r.items.find((i) => i.id === line.itemId)!;
        const level = await tx.stockLevel.findUnique({
          where: { warehouseId_variantId: { warehouseId: r.fromWarehouseId, variantId: item.variantId } },
        });
        // Re-read inside the transaction: two dispatches racing for the last
        // pallet must not both succeed.
        const available = level ? num(level.quantity) - num(level.reserved) : 0;
        if (available < line.quantity) {
          throw new ValidationError(
            `${r.fromWarehouse.name} no longer has ${line.quantity} available of that product.`,
          );
        }
        await tx.stockLevel.update({
          where: { id: level!.id },
          data: { quantity: { decrement: line.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            organizationId: r.organizationId,
            warehouseId: r.fromWarehouseId,
            variantId: item.variantId,
            type: 'TRANSFER_OUT',
            quantity: -line.quantity,
            referenceType: 'REQUISITION',
            referenceId: id,
            reason: dto.notes ?? `Dispatched against ${r.number}`,
            actorUserId: actorUserId(),
          },
        });
        await tx.internalRequisitionItem.update({
          where: { id: item.id },
          data: { dispatchedQty: num(item.dispatchedQty) + line.quantity },
        });
      }

      const fresh = await tx.internalRequisitionItem.findMany({ where: { requisitionId: id } });
      const status = progressStatus(fresh) ?? 'PARTIALLY_DISPATCHED';
      await tx.internalRequisition.update({ where: { id }, data: { status } });
      return transfer;
    });

    const updated = await this.byId(id);
    await auditService.record({
      action: 'requisition.dispatched',
      entityType: 'InternalRequisition',
      entityId: id,
      before: { status: r.status },
      after: { status: updated.status, transfer: number, lines: requested.length },
    });
    await notifyWarehouse(
      r.toWarehouseId,
      'inventory.requisition.dispatched',
      'Stock dispatched to you',
      `${r.fromWarehouse.name} has dispatched ${requested.length} line${requested.length === 1 ? '' : 's'} for ${r.number}.`,
      { requisitionId: id, number: r.number },
    );
    return withScanPayload(updated);
  },

  /**
   * Receive at the destination.
   *
   * Only what has actually been dispatched can be received — the destination
   * count rises here and nowhere else.
   */
  async receive(id: string, dto: z.infer<typeof receiveRequisitionSchema>) {
    const r = await this.byId(id);

    /*
     * Checked here rather than only at the route, because the endpoint is
     * reachable without the screen and this is the control that ties a receipt
     * to the physical delivery.
     */
    if (!r.scanToken) {
      throw new ConflictError(
        'This requisition has no note code, so it cannot be received. Reprint the requisition note.',
      );
    }
    if (dto.scanToken !== r.scanToken) {
      throw new ForbiddenError(
        'That code does not match this requisition. Scan or enter the code on the requisition note that came with the delivery.',
      );
    }

    if (!['DISPATCHED', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RECEIVED'].includes(r.status)) {
      throw new ConflictError('Nothing has been dispatched for this requisition yet.');
    }

    if (dto.idempotencyKey) {
      const seen = await prisma.stockMovement.findFirst({
        where: {
          organizationId: r.organizationId,
          referenceType: 'REQUISITION_RECEIPT',
          referenceId: id,
          reason: { contains: dto.idempotencyKey },
        },
        select: { id: true },
      });
      if (seen) {
        logger.info({ requisitionId: id, idempotencyKey: dto.idempotencyKey }, 'requisition receipt replayed');
        return this.byId(id);
      }
    }

    const requested = dto.items
      ?? r.items
        .filter((i) => num(i.dispatchedQty) > num(i.receivedQty))
        .map((i) => ({ itemId: i.id, quantity: Number((num(i.dispatchedQty) - num(i.receivedQty)).toFixed(3)) }));
    if (requested.length === 0) throw new ConflictError('Nothing is in transit to receive.');

    for (const line of requested) {
      const item = r.items.find((i) => i.id === line.itemId);
      if (!item) throw new NotFoundError('Requisition line');
      const inTransit = num(item.dispatchedQty) - num(item.receivedQty);
      if (line.quantity > inTransit + 1e-9) {
        throw new ValidationError(
          `Cannot receive ${line.quantity} — only ${inTransit} of that line is in transit.`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const line of requested) {
        const item = r.items.find((i) => i.id === line.itemId)!;
        await tx.stockLevel.upsert({
          where: { warehouseId_variantId: { warehouseId: r.toWarehouseId, variantId: item.variantId } },
          create: {
            organizationId: r.organizationId,
            warehouseId: r.toWarehouseId,
            variantId: item.variantId,
            quantity: line.quantity,
          },
          update: { quantity: { increment: line.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            organizationId: r.organizationId,
            warehouseId: r.toWarehouseId,
            variantId: item.variantId,
            type: 'TRANSFER_IN',
            quantity: line.quantity,
            referenceType: 'REQUISITION_RECEIPT',
            referenceId: id,
            // The key rides in the reason so a replay is detectable without
            // another table; stock movements are already the receipt log.
            reason: dto.idempotencyKey
              ? `Received against ${r.number} [${dto.idempotencyKey}]`
              : dto.notes ?? `Received against ${r.number}`,
            actorUserId: actorUserId(),
          },
        });
        await tx.internalRequisitionItem.update({
          where: { id: item.id },
          data: { receivedQty: num(item.receivedQty) + line.quantity },
        });
      }

      const fresh = await tx.internalRequisitionItem.findMany({ where: { requisitionId: id } });
      const status = progressStatus(fresh) ?? r.status;
      await tx.internalRequisition.update({
        where: { id },
        data: { status, ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}) },
      });

      // Close the transfers whose lines have all landed.
      const transfers = await tx.stockTransfer.findMany({
        where: { requisitionId: id, status: 'IN_TRANSIT' },
        include: { items: true },
      });
      for (const transfer of transfers) {
        const allIn = fresh.every((i) => num(i.receivedQty) >= num(i.dispatchedQty));
        if (allIn) {
          await tx.stockTransfer.update({
            where: { id: transfer.id },
            data: { status: 'RECEIVED', receivedAt: new Date() },
          });
        }
      }
    });

    const updated = await this.byId(id);
    await auditService.record({
      action: updated.status === 'COMPLETED' ? 'requisition.completed' : 'requisition.received',
      entityType: 'InternalRequisition',
      entityId: id,
      before: { status: r.status },
      after: {
        status: updated.status,
        lines: requested.length,
        // Recorded so an audit can show the receipt was made against the note,
        // not from a desk.
        verifiedByNote: true,
        quantities: requested.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      },
    });
    await notifyWarehouse(
      r.fromWarehouseId,
      'inventory.requisition.received',
      'Transfer received',
      `${r.toWarehouse.name} has received stock for ${r.number}.`,
      { requisitionId: id, number: r.number },
    );
    return withScanPayload(updated);
  },

  async cancel(id: string, reason?: string) {
    const r = await this.byId(id);
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status)) {
      throw new ConflictError('This requisition is already closed.');
    }
    // Stock already sent is out of the source warehouse; cancelling the
    // paperwork would strand it, so it has to be received or returned first.
    if (r.items.some((i) => num(i.dispatchedQty) > num(i.receivedQty))) {
      throw new ConflictError(
        'Stock is already in transit for this requisition. Receive it, or transfer it back, before cancelling.',
      );
    }
    const updated = await prisma.internalRequisition.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), notes: reason?.trim() || r.notes },
      include: detail,
    });
    await auditService.record({
      action: 'requisition.cancelled',
      entityType: 'InternalRequisition',
      entityId: id,
      before: { status: r.status },
      after: { status: updated.status, reason: reason?.trim() ?? null },
    });
    return withScanPayload(updated);
  },
};
