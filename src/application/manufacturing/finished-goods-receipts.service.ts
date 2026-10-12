import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { assertCanManage, assertCanRead, warehouseFieldFilter } from '../inventory/warehouse-access';
import { auditService } from '../audit/audit.service';
import { notifyService } from '../notifications/notify.service';
import { nextManufacturingDocumentNumber } from '../documents/document-number.service';
import { applyMovement } from './stock-ledger';
import { manufacturingSettings } from './settings.service';

const org = () => requestContext.get()?.organizationId ?? (() => { throw new Error('No tenant'); })();
const actor = () => requestContext.get()?.userId ?? null;
const n = (value: unknown) => Number(value ?? 0);

export function validateFinishedGoodsAllocation(approvedQuantity: number, allocations: Array<{ warehouseId: string; quantity: number }>) {
  if (!allocations.length) throw new ValidationError('Add at least one destination warehouse.');
  if (allocations.some((row) => !row.warehouseId || row.quantity <= 0)) throw new ValidationError('Every allocation needs a warehouse and a positive quantity.');
  if (new Set(allocations.map((row) => row.warehouseId)).size !== allocations.length) throw new ValidationError('Combine duplicate destination warehouse rows.');
  const total = allocations.reduce((sum, row) => sum + row.quantity, 0);
  if (total > approvedQuantity + 1e-6) throw new ValidationError('Allocation exceeds the QC-approved quantity.');
  return { total, unallocated: Math.max(0, approvedQuantity - total) };
}

export function validateFinishedGoodsReceipt(outstanding: number, quantity: number, discrepancyReason?: string) {
  if (quantity <= 0) throw new ValidationError('Received quantity must be positive.');
  if (quantity > outstanding + 1e-6) throw new ValidationError(`Only ${outstanding} remains outstanding on this receipt.`);
  if (quantity < outstanding && !discrepancyReason?.trim()) throw new ValidationError('Give a discrepancy reason when the delivery is short.');
  return { nextOutstanding: Math.max(0, outstanding - quantity), partial: quantity < outstanding };
}

export function deriveFinishedGoodsReceiptState(approvedQuantity: number, tasks: Array<{ allocatedQuantity: unknown; receivedQuantity: unknown }>) {
  const allocated = tasks.reduce((sum, row) => sum + n(row.allocatedQuantity), 0);
  const received = tasks.reduce((sum, row) => sum + n(row.receivedQuantity), 0);
  const fullyAllocated = allocated >= approvedQuantity - 1e-6;
  const allTasksReceived = tasks.length > 0 && tasks.every((row) => n(row.receivedQuantity) >= n(row.allocatedQuantity) - 1e-6);
  return { allocated, received, status: fullyAllocated && allTasksReceived ? 'RECEIVED' as const : received > 0 ? 'PARTIALLY_RECEIVED' as const : allocated > 0 ? 'AWAITING_RECEIPT' as const : 'PENDING_ALLOCATION' as const };
}

export const allocateFinishedGoodsSchema = z.object({
  allocations: z.array(z.object({ warehouseId: z.string().min(1), quantity: z.coerce.number().positive() })).min(1),
});
export const receiveFinishedGoodsSchema = z.object({
  quantity: z.coerce.number().positive(), idempotencyKey: z.string().trim().min(8).max(120),
  storageLocation: z.string().trim().max(120).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
  discrepancyReason: z.string().trim().max(300).optional(),
});

const receiptInclude = { tasks: { include: { warehouse: { select: { id: true, name: true, code: true } }, deliveries: true, discrepancies: true }, orderBy: { number: 'asc' as const } }, output: { include: { batch: true, variant: { include: { product: true } } } } } as const;

export const finishedGoodsReceiptsService = {
  async ensureForOutput(outputId: string, actorUserId: string | null) {
    const existing = await prisma.finishedGoodsReceipt.findUnique({ where: { productionOutputId: outputId }, include: receiptInclude });
    if (existing) return existing;
    const output = await prisma.productionOutput.findFirst({ where: { id: outputId }, include: { batch: true } });
    if (!output?.batchId || !output.batch) throw new ValidationError('Finished goods receipt requires a traceable production batch.');
    if (!['PASSED', 'CONDITIONAL'].includes(output.batch.qcStatus)) throw new ConflictError('The batch must pass quality control before finished goods can be allocated.');
    const batchId = output.batchId;
    const created = await prisma.$transaction(async (tx) => tx.finishedGoodsReceipt.create({
      data: {
        organizationId: output.organizationId,
        number: await nextManufacturingDocumentNumber(tx, output.organizationId, 'FGR'),
        productionOrderId: output.productionOrderId, productionOutputId: output.id, batchId,
        variantId: output.variantId, approvedQuantity: output.goodQuantity,
        scanToken: randomBytes(24).toString('base64url'), createdByUserId: actorUserId,
      },
      include: receiptInclude,
    }));
    const settings = await manufacturingSettings.get();
    if (settings.finishedGoodsReceivingMode === 'AUTOMATIC' && output.warehouseId) {
      return this.allocate(created.id, { allocations: [{ warehouseId: output.warehouseId, quantity: n(output.goodQuantity) }] });
    }
    return created;
  },

  async ensureForBatch(batchId: string, actorUserId: string | null) {
    const outputs = await prisma.productionOutput.findMany({ where: { batchId }, select: { id: true } });
    return Promise.all(outputs.map((output) => this.ensureForOutput(output.id, actorUserId)));
  },

  async list(filters: { warehouseId?: string; status?: string; productionOrderId?: string; search?: string; createdFrom?: Date; createdTo?: Date } = {}) {
    if (filters.warehouseId) await assertCanRead(filters.warehouseId);
    return prisma.finishedGoodsReceipt.findMany({
      where: {
        ...(filters.status ? { status: filters.status as any } : {}),
        ...(filters.productionOrderId ? { productionOrderId: filters.productionOrderId } : {}),
        ...(filters.createdFrom || filters.createdTo ? { createdAt: { ...(filters.createdFrom ? { gte: filters.createdFrom } : {}), ...(filters.createdTo ? { lte: filters.createdTo } : {}) } } : {}),
        ...(filters.search ? { OR: [
          { number: { contains: filters.search, mode: 'insensitive' as const } },
          { output: { batch: { batchNumber: { contains: filters.search, mode: 'insensitive' as const } } } },
          { output: { variant: { sku: { contains: filters.search, mode: 'insensitive' as const } } } },
          { output: { variant: { product: { name: { contains: filters.search, mode: 'insensitive' as const } } } } },
        ] } : {}),
        // Parent receipts exist before destination tasks. Do not hide them
        // from the allocation queue merely because allocation is the next job.
        ...(filters.warehouseId ? { tasks: { some: { warehouseId: filters.warehouseId } } } : {}),
      }, include: receiptInclude, orderBy: { createdAt: 'desc' },
    });
  },

  async get(id: string) {
    const receipt = await prisma.finishedGoodsReceipt.findFirst({ where: { id }, include: receiptInclude });
    if (!receipt) throw new NotFoundError('Finished goods receipt');
    return receipt;
  },

  async allocate(id: string, dto: z.infer<typeof allocateFinishedGoodsSchema>) {
    const receipt = await this.get(id);
    const settings = await manufacturingSettings.get();
    const automatic = settings.finishedGoodsReceivingMode === 'AUTOMATIC';
    const receivingStarted = !automatic && receipt.tasks.some((task) => n(task.receivedQuantity) > 0);
    const { total } = validateFinishedGoodsAllocation(n(receipt.approvedQuantity), dto.allocations);
    if (receivingStarted) {
      for (const task of receipt.tasks) {
        const submitted = dto.allocations.find((row) => row.warehouseId === task.warehouseId);
        if (!submitted || submitted.quantity + 1e-6 < n(task.allocatedQuantity)) {
          throw new ConflictError('Received warehouse allocations cannot be removed or reduced. Keep them and allocate only the remaining approved quantity.');
        }
      }
    }
    const warehouseIds = dto.allocations.map((row) => row.warehouseId);
    const warehouses = await prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, isActive: true, deletedAt: null }, select: { id: true, name: true, managerId: true } });
    if (warehouses.length !== warehouseIds.length) throw new ValidationError('Every destination must be an active warehouse in this business.');
    const result = await prisma.$transaction(async (tx) => {
      // Automatic allocations are already stock. Re-allocation first returns
      // every previous destination to the preferred staging warehouse, then
      // distributes the new plan. If any of that stock has since been spent,
      // the ledger guard rejects the change rather than inventing inventory.
      if (automatic) for (const old of receipt.tasks) {
        if (old.warehouseId === receipt.output.warehouseId || n(old.receivedQuantity) <= 0) continue;
        await assertCanManage(old.warehouseId);
        await applyMovement(tx, { organizationId: org(), warehouseId: old.warehouseId, variantId: receipt.variantId, quantityChange: -n(old.receivedQuantity), type: 'TRANSFER_OUT', referenceType: 'FINISHED_GOODS_REALLOCATION', referenceId: old.id, batchNumber: receipt.output.batch?.batchNumber, actorUserId: actor() });
        await applyMovement(tx, { organizationId: org(), warehouseId: receipt.output.warehouseId, variantId: receipt.variantId, quantityChange: n(old.receivedQuantity), type: 'TRANSFER_IN', referenceType: 'FINISHED_GOODS_REALLOCATION', referenceId: old.id, batchNumber: receipt.output.batch?.batchNumber, actorUserId: actor() });
      }
      if (!receivingStarted) await tx.finishedGoodsReceiptTask.deleteMany({ where: { receiptId: id } });
      for (const row of dto.allocations) {
        const existingTask = receivingStarted ? receipt.tasks.find((task) => task.warehouseId === row.warehouseId) : null;
        if (existingTask) {
          if (Math.abs(row.quantity - n(existingTask.allocatedQuantity)) > 1e-6) {
            await tx.finishedGoodsReceiptTask.update({ where: { id: existingTask.id }, data: { allocatedQuantity: row.quantity } });
          }
          continue;
        }
        const taskNumber = await nextManufacturingDocumentNumber(tx, org(), 'FGR');
        const task = await tx.finishedGoodsReceiptTask.create({ data: {
          organizationId: org(), receiptId: id, number: taskNumber, warehouseId: row.warehouseId,
          allocatedQuantity: row.quantity, receivedQuantity: automatic ? row.quantity : 0,
          status: automatic ? 'RECEIVED' : 'AWAITING_RECEIPT', scanToken: randomBytes(24).toString('base64url'),
          ...(automatic ? { deliveries: { create: { organizationId: org(), quantity: row.quantity, idempotencyKey: `automatic:${id}:${row.warehouseId}`, receivedByUserId: actor() } } } : {}),
        } });
        if (automatic && row.warehouseId !== receipt.output.warehouseId) {
          await assertCanManage(receipt.output.warehouseId);
          await applyMovement(tx, { organizationId: org(), warehouseId: receipt.output.warehouseId, variantId: receipt.variantId, quantityChange: -row.quantity, type: 'TRANSFER_OUT', referenceType: 'FINISHED_GOODS_RECEIPT', referenceId: task.id, batchNumber: receipt.output.batch?.batchNumber, actorUserId: actor() });
          await applyMovement(tx, { organizationId: org(), warehouseId: row.warehouseId, variantId: receipt.variantId, quantityChange: row.quantity, type: 'TRANSFER_IN', referenceType: 'FINISHED_GOODS_RECEIPT', referenceId: task.id, batchNumber: receipt.output.batch?.batchNumber, actorUserId: actor() });
        }
      }
      const received = automatic ? total : receipt.tasks.reduce((sum, task) => sum + n(task.receivedQuantity), 0);
      return tx.finishedGoodsReceipt.update({ where: { id }, data: { allocatedQuantity: total, receivedQuantity: received, status: automatic ? 'RECEIVED' : received > 0 ? 'PARTIALLY_RECEIVED' : 'AWAITING_RECEIPT' }, include: receiptInclude });
    });
    if (!automatic) for (const warehouse of warehouses) void notifyWarehouse(warehouse.managerId, result.tasks.find((task) => task.warehouseId === warehouse.id)!);
    await auditService.record({ action: 'finished_goods.allocated', entityType: 'FINISHED_GOODS_RECEIPT', entityId: id, after: { total, automatic, warehouses: warehouseIds } });
    return result;
  },

  async listTasks(filters: { warehouseId?: string; status?: string; search?: string; createdFrom?: Date; createdTo?: Date } = {}) {
    if (filters.warehouseId) await assertCanRead(filters.warehouseId);
    return prisma.finishedGoodsReceiptTask.findMany({ where: {
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : await warehouseFieldFilter()),
      ...(filters.status ? { status: filters.status as any } : {}),
      ...(filters.createdFrom || filters.createdTo ? { createdAt: { ...(filters.createdFrom ? { gte: filters.createdFrom } : {}), ...(filters.createdTo ? { lte: filters.createdTo } : {}) } } : {}),
      ...(filters.search ? { OR: [
        { number: { contains: filters.search, mode: 'insensitive' as const } },
        { warehouse: { name: { contains: filters.search, mode: 'insensitive' as const } } },
        { receipt: { number: { contains: filters.search, mode: 'insensitive' as const } } },
        { receipt: { output: { variant: { sku: { contains: filters.search, mode: 'insensitive' as const } } } } },
        { receipt: { output: { variant: { product: { name: { contains: filters.search, mode: 'insensitive' as const } } } } } },
      ] } : {}),
    }, include: { warehouse: { select: { id: true, name: true, code: true } }, receipt: { include: { output: { include: { batch: true, variant: { include: { product: true } } } } } }, deliveries: true, discrepancies: true }, orderBy: { createdAt: 'desc' } });
  },

  async getTask(id: string) {
    const task = await prisma.finishedGoodsReceiptTask.findFirst({ where: { id }, include: { warehouse: { select: { id: true, name: true, code: true } }, receipt: { include: { output: { include: { batch: true, variant: { include: { product: true } } } } } }, deliveries: true, discrepancies: true } });
    if (!task) throw new NotFoundError('Finished goods receiving task');
    await assertCanRead(task.warehouseId);
    return task;
  },

  async lookup(code: string) {
    const value = code.trim();
    const token = value.match(/^vhicasar:\/\/fgr\/(.+)$/i)?.[1];
    const parent = await prisma.finishedGoodsReceipt.findFirst({ where: { OR: [{ number: { equals: value, mode: 'insensitive' } }, ...(token ? [{ scanToken: token }] : [])] }, select: { id: true } });
    const scope = await warehouseFieldFilter();
    const tasks = await prisma.finishedGoodsReceiptTask.findMany({ where: { ...scope, OR: [{ number: { equals: value, mode: 'insensitive' } }, ...(token ? [{ scanToken: token }] : []), ...(parent ? [{ receiptId: parent.id }] : [])] }, include: { warehouse: { select: { id: true, name: true, code: true } }, receipt: { include: { output: { include: { batch: true, variant: { include: { product: true } } } } } }, deliveries: true, discrepancies: true } });
    if (!tasks.length) throw new NotFoundError('No authorized finished-goods receiving task matches that code');
    return tasks;
  },

  async receive(taskId: string, dto: z.infer<typeof receiveFinishedGoodsSchema>) {
    const authorizedTask = await prisma.finishedGoodsReceiptTask.findFirst({ where: { id: taskId }, select: { warehouseId: true } });
    if (!authorizedTask) throw new NotFoundError('Finished goods receiving task');
    await assertCanManage(authorizedTask.warehouseId);
    const delivery = await prisma.$transaction(async (tx) => {
      // Serialize scans/posts for one task. Without this lock two devices can
      // both validate against the same outstanding quantity and over-receive.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`finished-goods-receipt:${org()}:${taskId}`}))`;
      const duplicate = await tx.finishedGoodsReceiptDelivery.findFirst({ where: { organizationId: org(), idempotencyKey: dto.idempotencyKey } });
      if (duplicate) return duplicate;
      const task = await tx.finishedGoodsReceiptTask.findFirst({ where: { id: taskId }, include: { receipt: { include: { output: { include: { batch: true } } } } } });
      if (!task) throw new NotFoundError('Finished goods receiving task');
      const outstanding = n(task.allocatedQuantity) - n(task.receivedQuantity);
      validateFinishedGoodsReceipt(outstanding, dto.quantity, dto.discrepancyReason);
      await applyMovement(tx, { organizationId: task.organizationId, warehouseId: task.warehouseId, variantId: task.receipt.variantId, quantityChange: dto.quantity, type: 'FINISHED_GOODS_RECEIPT', referenceType: 'FINISHED_GOODS_RECEIPT_TASK', referenceId: task.id, reason: dto.notes, batchNumber: task.receipt.output.batch?.batchNumber, expiryDate: task.receipt.output.expiryDate, actorUserId: actor() });
      const next = n(task.receivedQuantity) + dto.quantity;
      const created = await tx.finishedGoodsReceiptDelivery.create({ data: { organizationId: task.organizationId, taskId, quantity: dto.quantity, storageLocation: dto.storageLocation, notes: dto.notes, idempotencyKey: dto.idempotencyKey, receivedByUserId: actor() } });
      if (dto.discrepancyReason && dto.quantity < outstanding) await tx.finishedGoodsReceiptDiscrepancy.create({ data: { organizationId: task.organizationId, taskId, expectedQuantity: outstanding, receivedQuantity: dto.quantity, difference: dto.quantity - outstanding, reason: dto.discrepancyReason, notes: dto.notes, reportedByUserId: actor() } });
      await tx.finishedGoodsReceiptTask.update({ where: { id: taskId }, data: { receivedQuantity: next, status: next >= n(task.allocatedQuantity) ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } });
      const allTasks = await tx.finishedGoodsReceiptTask.findMany({ where: { receiptId: task.receiptId }, select: { allocatedQuantity: true, receivedQuantity: true } });
      const parent = deriveFinishedGoodsReceiptState(n(task.receipt.approvedQuantity), allTasks);
      await tx.finishedGoodsReceipt.update({ where: { id: task.receiptId }, data: { allocatedQuantity: parent.allocated, receivedQuantity: parent.received, status: parent.status } });
      return created;
    });
    await auditService.record({ action: 'finished_goods.received', entityType: 'FINISHED_GOODS_RECEIPT_TASK', entityId: taskId, after: { quantity: dto.quantity, warehouseId: authorizedTask.warehouseId, deliveryId: delivery.id } });
    // Return the authoritative updated document, not only the delivery event.
    // Both web and mobile render task/parent state from this contract.
    return { delivery, task: await this.getTask(taskId) };
  },
};

async function notifyWarehouse(managerMembershipId: string | null, task: { id: string; number: string; warehouseId: string; organizationId: string }) {
  if (!managerMembershipId) return;
  const membership = await prisma.membership.findFirst({ where: { id: managerMembershipId, isActive: true, deletedAt: null }, select: { userId: true } });
  if (!membership) return;
  await notifyService.notifyUsers(task.organizationId, [membership.userId], { type: 'manufacturing.finished_goods_receipt.ready', title: 'Finished goods awaiting receipt', body: `${task.number} is ready for physical receipt.`, data: { finishedGoodsReceiptTaskId: task.id, warehouseId: task.warehouseId } }).catch(() => {});
}
