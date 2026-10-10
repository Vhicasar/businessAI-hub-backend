import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { assertCanManage, assertCanRead, warehouseFieldFilter } from '../inventory/warehouse-access';
import { applyMovement } from './stock-ledger';
import { materialAllocationService } from './material-allocation.service';
import { manufacturingSettings } from './settings.service';
import { notifyService } from '../notifications/notify.service';
import { logger } from '../../shared/logger';
import { nextManufacturingDocumentNumber } from '../documents/document-number.service';

const actor = () => requestContext.get()?.userId ?? null;
const org = () => requestContext.get()?.organizationId ?? (() => { throw new Error('No tenant'); })();
const n = (value: unknown) => Number(value ?? 0);

export const createMaterialRequisitionSchema = z.object({
  requiredAt: z.coerce.date().nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
  allocations: z.array(z.object({
    materialId: z.string().min(1), warehouseId: z.string().min(1),
    quantity: z.coerce.number().positive(), batchId: z.string().min(1).nullable().optional(),
  })).optional(),
});
export const issueMaterialDocumentSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  items: z.array(z.object({ lineId: z.string().min(1), quantity: z.coerce.number().min(0), varianceReason: z.string().trim().max(300).optional() })).min(1),
  notes: z.string().trim().max(1000).optional(),
});
export const receiveMaterialIssueSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  discrepancy: z.array(z.object({ lineId: z.string().min(1), receivedQuantity: z.coerce.number().min(0), reason: z.string().trim().min(1).max(300), notes: z.string().trim().max(1000).optional() })).optional(),
});
export const createMaterialReturnSchema = z.object({
  warehouseId: z.string().min(1), notes: z.string().trim().max(1000).optional(),
  items: z.array(z.object({ variantId: z.string().min(1), quantity: z.coerce.number().positive() })).min(1),
});
export const receiveMaterialReturnSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(120), items: z.array(z.object({ lineId: z.string(), quantity: z.coerce.number().min(0) })).optional() });

const issueInclude = { lines: true, requisition: { select: { number: true, status: true } } } as const;

export const materialRequisitionsService = {
  async allocate(productionOrderId: string) { return materialAllocationService.forOrder(productionOrderId); },

  async create(productionOrderId: string, dto: z.infer<typeof createMaterialRequisitionSchema>) {
    const existing = await prisma.productionMaterialRequisition.findFirst({ where: { productionOrderId, status: { notIn: ['REJECTED', 'CANCELLED'] } }, include: { lines: { include: { allocations: true } }, issues: { include: { lines: true } } } });
    if (existing) return existing;
    const order = await prisma.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, select: { id: true, status: true, materials: true } });
    if (!order) throw new NotFoundError('Production order');
    if (order.materials.length === 0) throw new ValidationError('This production order has no material requirements.');
    const allocation = dto.allocations?.length
      ? await materialAllocationService.validateOverrides(productionOrderId, dto.allocations)
      : await materialAllocationService.forOrder(productionOrderId);
    const settings = await manufacturingSettings.get();
    const needsApproval = settings.materialIssueApprovalMode !== 'NONE';
    const result = await prisma.$transaction(async (tx) => {
      const number = await nextManufacturingDocumentNumber(tx, org(), 'MR');
      const created = await tx.productionMaterialRequisition.create({
        data: {
          organizationId: org(), number, productionOrderId, status: needsApproval ? 'SUBMITTED' : 'READY_FOR_ISSUE',
          requestedByUserId: actor(), requiredAt: dto.requiredAt ?? null, notes: dto.notes ?? null,
          lines: { create: allocation.map((item) => ({
            organizationId: org(), productionMaterialId: item.materialId, variantId: item.variantId,
            requiredQuantity: item.requiredQuantity, allocatedQuantity: item.availableQuantity,
            shortageQuantity: item.shortageQuantity,
            allocations: { create: item.allocations.map((a) => ({ organizationId: org(), warehouseId: a.warehouseId, batchId: a.batchId, quantity: a.quantity })) },
          })) },
        }, include: { lines: { include: { allocations: true } } },
      });
      if (!needsApproval) await createIssues(tx, created.id, productionOrderId, created.lines);
      return created;
    });
    await auditService.record({ action: 'production.material_requisition.created', entityType: 'PRODUCTION_MATERIAL_REQUISITION', entityId: result.id, after: { number: result.number, status: result.status, productionOrderId } });
    const detailed = await this.get(result.id);
    if (!needsApproval) for (const issue of detailed.issues) void notifyWarehouse(issue.warehouseId, 'manufacturing.material_issue.ready', 'Materials ready for picking', `${issue.number} is ready for this warehouse.`, { materialIssueId: issue.id, productionOrderId });
    return detailed;
  },

  async get(id: string) {
    const row = await prisma.productionMaterialRequisition.findFirst({ where: { id }, include: { lines: { include: { allocations: true } }, issues: { include: { lines: true }, orderBy: { number: 'asc' } } } });
    if (!row) throw new NotFoundError('Material requisition');
    return row;
  },
  async forOrder(productionOrderId: string) {
    return prisma.productionMaterialRequisition.findFirst({ where: { productionOrderId, status: { notIn: ['REJECTED', 'CANCELLED'] } }, include: { lines: { include: { allocations: true } }, issues: { include: { lines: true }, orderBy: { number: 'asc' } } }, orderBy: { createdAt: 'desc' } });
  },

  async approve(id: string) {
    const req = await this.get(id);
    if (req.status !== 'SUBMITTED') throw new ConflictError('Only a submitted material requisition can be approved.');
    const updated = await prisma.$transaction(async (tx) => {
      await createIssues(tx, req.id, req.productionOrderId, req.lines);
      return tx.productionMaterialRequisition.update({ where: { id }, data: { status: 'READY_FOR_ISSUE', approvedByUserId: actor(), approvedAt: new Date() } });
    });
    await auditService.record({ action: 'production.material_requisition.approved', entityType: 'PRODUCTION_MATERIAL_REQUISITION', entityId: id, before: { status: req.status }, after: { status: updated.status } });
    const detailed = await this.get(id);
    for (const issue of detailed.issues) void notifyWarehouse(issue.warehouseId, 'manufacturing.material_issue.ready', 'Materials ready for picking', `${issue.number} is ready for this warehouse.`, { materialIssueId: issue.id, productionOrderId: req.productionOrderId });
    return detailed;
  },

  async listIssues(filters: { warehouseId?: string; status?: string; search?: string } = {}) {
    if (filters.warehouseId) await assertCanRead(filters.warehouseId);
    const rows = await prisma.productionMaterialIssue.findMany({ where: {
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : await warehouseFieldFilter()),
      ...(filters.status ? { status: filters.status as any } : {}),
      ...(filters.search ? { number: { contains: filters.search, mode: 'insensitive' } } : {}),
    }, include: issueInclude, orderBy: { createdAt: 'desc' } });
    return enrichIssues(rows);
  },

  async lookup(code: string) {
    const value = code.trim();
    const token = value.match(/^vhicasar:\/\/production-material-issue\/(.+)$/i)?.[1];
    const [requisition, productionOrder] = await Promise.all([
      prisma.productionMaterialRequisition.findFirst({ where: { number: { equals: value, mode: 'insensitive' } }, select: { id: true } }),
      prisma.productionOrder.findFirst({ where: { orderNumber: { equals: value, mode: 'insensitive' }, deletedAt: null }, select: { id: true } }),
    ]);
    const issues = await prisma.productionMaterialIssue.findMany({
      where: {
        ...(await warehouseFieldFilter()),
        OR: [
          ...(token ? [{ scanToken: token }] : []),
          { number: { equals: value, mode: 'insensitive' } },
          ...(requisition ? [{ requisitionId: requisition.id }] : []),
          ...(productionOrder ? [{ productionOrderId: productionOrder.id }] : []),
        ],
      },
      include: issueInclude,
      orderBy: { createdAt: 'asc' },
    });
    if (!issues.length) throw new NotFoundError('No authorized material issue matches that document code');
    return enrichIssues(issues);
  },

  async byScanToken(token: string) {
    const issue = await prisma.productionMaterialIssue.findFirst({ where: { scanToken: token }, include: issueInclude });
    if (!issue) throw new NotFoundError('Material issue');
    await assertCanRead(issue.warehouseId);
    return { ...issue, scanPayload: `vhicasar://production-material-issue/${issue.scanToken}` };
  },

  async getIssue(id: string) {
    const issue = await prisma.productionMaterialIssue.findFirst({ where: { id }, include: issueInclude });
    if (!issue) throw new NotFoundError('Material issue');
    await assertCanRead(issue.warehouseId);
    return (await enrichIssues([issue]))[0];
  },

  async startPicking(id: string) {
    const issue = await loadIssue(id); await assertCanManage(issue.warehouseId);
    if (issue.status !== 'READY_FOR_PICKING') throw new ConflictError('This material issue is not awaiting picking.');
    const updated = await prisma.productionMaterialIssue.update({ where: { id }, data: { status: 'PICKING', pickedByUserId: actor(), pickedAt: new Date() } });
    await auditService.record({ action: 'production.material_issue.picking_started', entityType: 'PRODUCTION_MATERIAL_ISSUE', entityId: id, before: { status: issue.status }, after: { status: updated.status, warehouseId: issue.warehouseId } });
    return updated;
  },

  async finishPicking(id: string, items?: Array<{ lineId: string; quantity: number }>) {
    const issue = await loadIssue(id); await assertCanManage(issue.warehouseId);
    if (issue.status !== 'PICKING') throw new ConflictError('Start picking before completing the pick.');
    return prisma.$transaction(async (tx) => {
      for (const line of issue.lines) await tx.productionMaterialIssueLine.update({ where: { id: line.id }, data: { pickedQuantity: items?.find((i) => i.lineId === line.id)?.quantity ?? line.requestedQuantity } });
      return tx.productionMaterialIssue.update({ where: { id }, data: { status: 'READY_FOR_HANDOVER' } });
    });
  },

  async confirmIssue(id: string, dto: z.infer<typeof issueMaterialDocumentSchema>) {
    const issue = await loadIssue(id); await assertCanManage(issue.warehouseId);
    if (issue.issueIdempotencyKey === dto.idempotencyKey) return issue;
    if (!['READY_FOR_HANDOVER', 'PARTIALLY_ISSUED'].includes(issue.status)) throw new ConflictError('This material issue is not ready for handover.');
    const result = await prisma.$transaction(async (tx) => {
      for (const input of dto.items) {
        const line = issue.lines.find((row) => row.id === input.lineId); if (!line) throw new NotFoundError('Material issue line');
        const outstanding = n(line.requestedQuantity) - n(line.issuedQuantity);
        if (input.quantity > outstanding + 1e-6) throw new ValidationError('Actual issue cannot exceed the outstanding approved quantity.');
        if (input.quantity > 0) await applyMovement(tx, { organizationId: issue.organizationId, warehouseId: issue.warehouseId, variantId: line.variantId, quantityChange: -input.quantity, type: 'MATERIAL_ISSUE', referenceType: 'PRODUCTION_MATERIAL_ISSUE', referenceId: id, reason: input.varianceReason ?? dto.notes, actorUserId: actor() });
        await tx.productionMaterialIssueLine.update({ where: { id: line.id }, data: { issuedQuantity: { increment: input.quantity }, varianceReason: input.varianceReason ?? null } });
        await tx.productionMaterial.update({ where: { id: line.requisitionLine.productionMaterialId }, data: { issuedQuantity: { increment: input.quantity } } });
      }
      const fresh = await tx.productionMaterialIssueLine.findMany({ where: { issueId: id } });
      const complete = fresh.every((line) => n(line.issuedQuantity) >= n(line.requestedQuantity));
      const updated = await tx.productionMaterialIssue.update({ where: { id }, data: { status: complete ? 'ISSUED' : 'PARTIALLY_ISSUED', issuedByUserId: actor(), issuedAt: new Date(), issueIdempotencyKey: dto.idempotencyKey, notes: dto.notes } });
      await refreshRequisition(tx, issue.requisitionId);
      return updated;
    });
    await auditService.record({ action: 'production.material_issue.issued', entityType: 'PRODUCTION_MATERIAL_ISSUE', entityId: id, before: { status: issue.status }, after: { status: result.status, warehouseId: issue.warehouseId, lines: dto.items } });
    void notifyRequester(issue.requisitionId, 'manufacturing.material_issue.issued', 'Materials issued', `${issue.number} was issued and is ready for production receipt.`, { materialIssueId: id, productionOrderId: issue.productionOrderId });
    return result;
  },

  async confirmReceipt(id: string, dto: z.infer<typeof receiveMaterialIssueSchema>) {
    const issue = await loadIssue(id);
    if (issue.receiptIdempotencyKey === dto.idempotencyKey) return issue;
    if (!['ISSUED', 'PARTIALLY_RECEIVED'].includes(issue.status)) throw new ConflictError('Only issued materials can be received by production.');
    const result = await prisma.$transaction(async (tx) => {
      for (const line of issue.lines) {
        const report = dto.discrepancy?.find((item) => item.lineId === line.id);
        const received = report?.receivedQuantity ?? n(line.issuedQuantity);
        await tx.productionMaterialIssueLine.update({ where: { id: line.id }, data: { receivedQuantity: received } });
        await tx.productionMaterial.update({ where: { id: line.requisitionLine.productionMaterialId }, data: { receivedQuantity: { increment: received } } });
        if (report && Math.abs(received - n(line.issuedQuantity)) > 1e-6) await tx.productionMaterialDiscrepancy.create({ data: { organizationId: issue.organizationId, issueId: id, issueLineId: line.id, expectedQuantity: line.issuedQuantity, reportedQuantity: received, difference: received - n(line.issuedQuantity), reason: report.reason, notes: report.notes, reportedByUserId: actor() } });
      }
      const updated = await tx.productionMaterialIssue.update({ where: { id }, data: { status: 'RECEIVED', receivedByUserId: actor(), receivedAt: new Date(), receiptIdempotencyKey: dto.idempotencyKey } });
      await refreshRequisition(tx, issue.requisitionId);
      return updated;
    });
    await auditService.record({ action: 'production.material_issue.received', entityType: 'PRODUCTION_MATERIAL_ISSUE', entityId: id, before: { status: issue.status }, after: { status: result.status } });
    return result;
  },

  async createReturn(productionOrderId: string, dto: z.infer<typeof createMaterialReturnSchema>) {
    await assertCanRead(dto.warehouseId);
    const order = await prisma.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, select: { id: true, materials: true } });
    if (!order) throw new NotFoundError('Production order');
    for (const input of dto.items) {
      const material = order.materials.find((item) => item.variantId === input.variantId);
      if (!material) throw new ValidationError('A return item is not part of this production order.');
      const unused = n(material.receivedQuantity) - n(material.consumedQuantity);
      if (input.quantity > unused + 1e-6) throw new ValidationError(`Only ${unused} remains unused and available to return.`);
    }
    const created = await prisma.$transaction(async (tx) => {
      const number = await nextManufacturingDocumentNumber(tx, org(), 'RT');
      return tx.productionMaterialReturn.create({ data: { organizationId: org(), number, productionOrderId, warehouseId: dto.warehouseId, requestedByUserId: actor(), scanToken: randomBytes(24).toString('hex'), notes: dto.notes, lines: { create: dto.items.map((item) => ({ organizationId: org(), variantId: item.variantId, requestedQuantity: item.quantity })) } }, include: { lines: true } });
    });
    await auditService.record({ action: 'production.material_return.created', entityType: 'PRODUCTION_MATERIAL_RETURN', entityId: created.id, after: { number: created.number, productionOrderId, warehouseId: dto.warehouseId } });
    return created;
  },

  async confirmReturn(id: string, dto: z.infer<typeof receiveMaterialReturnSchema>) {
    const row = await prisma.productionMaterialReturn.findFirst({ where: { id }, include: { lines: true } });
    if (!row) throw new NotFoundError('Material return');
    await assertCanManage(row.warehouseId);
    if (row.receiptIdempotencyKey === dto.idempotencyKey) return row;
    if (row.status !== 'AWAITING_WAREHOUSE_RECEIPT') throw new ConflictError('This material return is already closed.');
    const updated = await prisma.$transaction(async (tx) => {
      for (const line of row.lines) {
        const quantity = dto.items?.find((item) => item.lineId === line.id)?.quantity ?? n(line.requestedQuantity);
        if (quantity > n(line.requestedQuantity) + 1e-6) throw new ValidationError('Received return cannot exceed the declared return quantity.');
        if (quantity > 0) await applyMovement(tx, { organizationId: row.organizationId, warehouseId: row.warehouseId, variantId: line.variantId, quantityChange: quantity, type: 'MATERIAL_RETURN', referenceType: 'PRODUCTION_MATERIAL_RETURN', referenceId: row.id, actorUserId: actor() });
        await tx.productionMaterialReturnLine.update({ where: { id: line.id }, data: { receivedQuantity: quantity } });
        await tx.productionMaterial.updateMany({ where: { productionOrderId: row.productionOrderId, variantId: line.variantId }, data: { receivedQuantity: { decrement: quantity }, issuedQuantity: { decrement: quantity } } });
      }
      return tx.productionMaterialReturn.update({ where: { id }, data: { status: 'RECEIVED', receivedByUserId: actor(), receivedAt: new Date(), receiptIdempotencyKey: dto.idempotencyKey }, include: { lines: true } });
    });
    await auditService.record({ action: 'production.material_return.received', entityType: 'PRODUCTION_MATERIAL_RETURN', entityId: id, before: { status: row.status }, after: { status: updated.status, warehouseId: row.warehouseId } });
    return updated;
  },
};

async function loadIssue(id: string) {
  const issue = await prisma.productionMaterialIssue.findFirst({ where: { id }, include: { lines: { include: { requisitionLine: true } } } });
  if (!issue) throw new NotFoundError('Material issue'); return issue;
}

async function enrichIssues(rows: any[]) {
  const warehouseIds = [...new Set(rows.map((row) => row.warehouseId))] as string[];
  const orderIds = [...new Set(rows.map((row) => row.productionOrderId))] as string[];
  const variantIds = [...new Set(rows.flatMap((row) => row.lines.map((line: any) => line.variantId)))] as string[];
  const [warehouses, orders, variants] = await Promise.all([
    prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true, code: true } }),
    prisma.productionOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, product: { select: { name: true } } } }),
    prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, sku: true, product: { select: { name: true, unit: true } } } }),
  ]);
  return rows.map((row) => ({
    ...row,
    warehouse: warehouses.find((item) => item.id === row.warehouseId) ?? null,
    productionOrder: orders.find((item) => item.id === row.productionOrderId) ?? null,
    lines: row.lines.map((line: any) => ({ ...line, variant: variants.find((item) => item.id === line.variantId) ?? null })),
    scanPayload: `vhicasar://production-material-issue/${row.scanToken}`,
  }));
}

async function createIssues(tx: any, requisitionId: string, productionOrderId: string, lines: any[]) {
  const allocations = lines.flatMap((line) => line.allocations.map((allocation: any) => ({ line, allocation })));
  const warehouses = [...new Set(allocations.map((item: any) => item.allocation.warehouseId as string))].sort();
  for (const warehouseId of warehouses) {
    const number = await nextManufacturingDocumentNumber(tx, org(), 'MI');
    await tx.productionMaterialIssue.create({ data: { organizationId: org(), number, productionOrderId, requisitionId, warehouseId, scanToken: randomBytes(24).toString('hex'), lines: { create: allocations.filter((item: any) => item.allocation.warehouseId === warehouseId).map((item: any) => ({ organizationId: org(), requisitionLineId: item.line.id, variantId: item.line.variantId, requestedQuantity: item.allocation.quantity })) } } });
  }
}

async function refreshRequisition(tx: any, id: string) {
  const issues = await tx.productionMaterialIssue.findMany({ where: { requisitionId: id }, select: { status: true } });
  const allReceived = issues.length > 0 && issues.every((i: any) => i.status === 'RECEIVED');
  const someReceived = issues.some((i: any) => ['RECEIVED', 'PARTIALLY_RECEIVED'].includes(i.status));
  const allIssued = issues.length > 0 && issues.every((i: any) => ['ISSUED', 'RECEIVED'].includes(i.status));
  const someIssued = issues.some((i: any) => ['PARTIALLY_ISSUED', 'ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(i.status));
  const status = allReceived ? 'RECEIVED' : someReceived ? 'PARTIALLY_RECEIVED' : allIssued ? 'ISSUED' : someIssued ? 'PARTIALLY_ISSUED' : 'READY_FOR_ISSUE';
  await tx.productionMaterialRequisition.update({ where: { id }, data: { status } });
}

async function notifyWarehouse(warehouseId: string, type: string, title: string, body: string, data: Record<string, unknown>) {
  try {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId }, select: { organizationId: true, managerId: true } });
    if (!warehouse?.managerId) return;
    const member = await prisma.membership.findFirst({ where: { id: warehouse.managerId, isActive: true, deletedAt: null }, select: { userId: true } });
    if (member) await notifyService.notifyUsers(warehouse.organizationId, [member.userId], { type, title, body, data });
  } catch (error) { logger.warn({ error: (error as Error).message, warehouseId, type }, 'production material notification failed'); }
}

async function notifyRequester(requisitionId: string, type: string, title: string, body: string, data: Record<string, unknown>) {
  try {
    const req = await prisma.productionMaterialRequisition.findFirst({ where: { id: requisitionId }, select: { organizationId: true, requestedByUserId: true } });
    if (req?.requestedByUserId) await notifyService.notifyUsers(req.organizationId, [req.requestedByUserId], { type, title, body, data });
  } catch (error) { logger.warn({ error: (error as Error).message, requisitionId, type }, 'production requester notification failed'); }
}
