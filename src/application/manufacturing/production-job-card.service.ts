import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';
import { documentQrService } from '../documents/document-qr.service';

/** Live job-card projection. No allocation state is copied into a document table. */
export const productionJobCardService = {
  async get(productionOrderId: string) {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      include: {
        product: true, bom: true, productionLine: true,
        materials: { include: { variant: { include: { product: true } } } },
        outputs: { include: { batch: true }, orderBy: { productionDate: 'asc' } },
      },
    });
    if (!order) throw new NotFoundError('Production order');
    const [requisitions, receipts, scan] = await Promise.all([
      prisma.productionMaterialRequisition.findMany({ where: { productionOrderId }, include: { lines: { include: { allocations: true } }, issues: { include: { lines: true } } }, orderBy: { createdAt: 'asc' } }),
      prisma.finishedGoodsReceipt.findMany({ where: { productionOrderId }, include: { tasks: { orderBy: { number: 'asc' } }, output: { include: { batch: true } } }, orderBy: { createdAt: 'asc' } }),
      documentQrService.productionOrderPayload(productionOrderId),
    ]);
    const warehouseIds = [...new Set([
      ...requisitions.flatMap((request) => request.lines.flatMap((line) => line.allocations.map((allocation) => allocation.warehouseId))),
      ...receipts.flatMap((receipt) => receipt.tasks.map((task) => task.warehouseId)),
    ])];
    const warehouses = await prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true, code: true } });
    const warehouse = (id: string) => warehouses.find((row) => row.id === id) ?? { id, name: 'Unknown warehouse', code: '' };

    const sources = new Map<string, { warehouse: ReturnType<typeof warehouse>; materials: Array<Record<string, unknown>> }>();
    for (const request of requisitions) for (const line of request.lines) {
      const material = order.materials.find((row) => row.id === line.productionMaterialId);
      for (const allocation of line.allocations) {
        const group = sources.get(allocation.warehouseId) ?? { warehouse: warehouse(allocation.warehouseId), materials: [] };
        const issueLines = request.issues.flatMap((issue) => issue.lines).filter((issueLine) => issueLine.requisitionLineId === line.id);
        group.materials.push({ name: material?.variant.product.name ?? material?.variant.sku ?? 'Material', sku: material?.variant.sku ?? '', unit: line.unit ?? material?.unit ?? material?.variant.product.unit, requiredQuantity: Number(line.requiredQuantity), allocatedQuantity: Number(allocation.quantity), issuedQuantity: issueLines.reduce((sum, row) => sum + Number(row.issuedQuantity), 0), receivedQuantity: issueLines.reduce((sum, row) => sum + Number(row.receivedQuantity), 0) });
        sources.set(allocation.warehouseId, group);
      }
    }
    return {
      generatedAt: new Date().toISOString(), scanPayload: scan.payload,
      order: { id: order.id, orderNumber: order.orderNumber, status: order.status, priority: order.priority, plannedQuantity: Number(order.plannedQuantity), actualQuantity: Number(order.actualQuantity), rejectedQuantity: Number(order.rejectedQuantity), startDate: order.startDate, expectedCompletionDate: order.expectedCompletionDate, notes: order.notes, product: { name: order.product.name, unit: order.product.unit }, bomNumber: order.bom?.bomNumber ?? null, productionLine: order.productionLine?.name ?? null },
      materialRequisitions: requisitions.map((request) => ({ id: request.id, number: request.number, status: request.status })),
      sourceWarehouses: [...sources.values()],
      materials: order.materials.map((row) => ({ name: row.variant.product.name, sku: row.variant.sku, unit: row.unit ?? row.variant.product.unit, requiredQuantity: Number(row.requiredQuantity), issuedQuantity: Number(row.issuedQuantity), receivedQuantity: Number(row.receivedQuantity), consumedQuantity: Number(row.consumedQuantity) })),
      batches: order.outputs.map((output) => ({ outputId: output.id, batchNumber: output.batch?.batchNumber ?? null, qcStatus: output.batch?.qcStatus ?? null, producedQuantity: Number(output.producedQuantity), goodQuantity: Number(output.goodQuantity), rejectedQuantity: Number(output.rejectedQuantity) })),
      finishedGoodsReceipts: receipts.map((receipt) => ({ id: receipt.id, number: receipt.number, status: receipt.status, approvedQuantity: Number(receipt.approvedQuantity), allocatedQuantity: Number(receipt.allocatedQuantity), receivedQuantity: Number(receipt.receivedQuantity), batchNumber: receipt.output.batch?.batchNumber ?? null, destinations: receipt.tasks.map((task) => ({ id: task.id, number: task.number, warehouse: warehouse(task.warehouseId), allocatedQuantity: Number(task.allocatedQuantity), receivedQuantity: Number(task.receivedQuantity), outstandingQuantity: Math.max(0, Number(task.allocatedQuantity) - Number(task.receivedQuantity)), status: task.status })) })),
    };
  },
};
