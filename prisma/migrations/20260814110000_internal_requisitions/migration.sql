-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "StockTransfer" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requisitionId" TEXT;

-- CreateTable
CREATE TABLE "InternalRequisition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "toWarehouseId" TEXT NOT NULL,
    "fromWarehouseId" TEXT NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT,
    "notes" TEXT,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "scanToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalRequisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalRequisitionItem" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "requestedQty" DECIMAL(12,3) NOT NULL,
    "approvedQty" DECIMAL(12,3),
    "dispatchedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "receivedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "InternalRequisitionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalRequisition_scanToken_key" ON "InternalRequisition"("scanToken");

-- CreateIndex
CREATE INDEX "InternalRequisition_organizationId_status_idx" ON "InternalRequisition"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InternalRequisition_organizationId_number_key" ON "InternalRequisition"("organizationId", "number");

-- CreateIndex
CREATE INDEX "InternalRequisitionItem_requisitionId_idx" ON "InternalRequisitionItem"("requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_organizationId_idempotencyKey_key" ON "StockTransfer"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "InternalRequisition" ADD CONSTRAINT "InternalRequisition_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalRequisition" ADD CONSTRAINT "InternalRequisition_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalRequisitionItem" ADD CONSTRAINT "InternalRequisitionItem_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "InternalRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalRequisitionItem" ADD CONSTRAINT "InternalRequisitionItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "InternalRequisition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

