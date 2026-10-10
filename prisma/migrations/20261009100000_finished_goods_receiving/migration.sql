CREATE TYPE "FinishedGoodsReceivingMode" AS ENUM ('AUTOMATIC', 'WAREHOUSE_CONFIRMATION');
CREATE TYPE "FinishedGoodsReceiptStatus" AS ENUM ('PENDING_ALLOCATION', 'AWAITING_RECEIPT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
ALTER TYPE "StockMovementType" ADD VALUE 'FINISHED_GOODS_RECEIPT';
ALTER TABLE "ManufacturingSettings" ADD COLUMN "finishedGoodsReceivingMode" "FinishedGoodsReceivingMode" NOT NULL DEFAULT 'AUTOMATIC';

CREATE TABLE "FinishedGoodsReceipt" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "number" TEXT NOT NULL,
  "productionOrderId" TEXT NOT NULL, "productionOutputId" TEXT NOT NULL, "batchId" TEXT NOT NULL,
  "variantId" TEXT NOT NULL, "approvedQuantity" DECIMAL(12,3) NOT NULL,
  "allocatedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0, "receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "status" "FinishedGoodsReceiptStatus" NOT NULL DEFAULT 'PENDING_ALLOCATION', "scanToken" TEXT NOT NULL,
  "createdByUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinishedGoodsReceipt_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinishedGoodsReceiptTask" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "receiptId" TEXT NOT NULL, "number" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL, "allocatedQuantity" DECIMAL(12,3) NOT NULL, "receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "status" "FinishedGoodsReceiptStatus" NOT NULL DEFAULT 'AWAITING_RECEIPT', "scanToken" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinishedGoodsReceiptTask_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinishedGoodsReceiptDelivery" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "taskId" TEXT NOT NULL, "quantity" DECIMAL(12,3) NOT NULL,
  "storageLocation" TEXT, "notes" TEXT, "idempotencyKey" TEXT NOT NULL, "receivedByUserId" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinishedGoodsReceiptDelivery_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinishedGoodsReceiptDiscrepancy" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
  "expectedQuantity" DECIMAL(12,3) NOT NULL, "receivedQuantity" DECIMAL(12,3) NOT NULL,
  "difference" DECIMAL(12,3) NOT NULL, "reason" TEXT NOT NULL, "notes" TEXT,
  "reportedByUserId" TEXT, "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "FinishedGoodsReceiptDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinishedGoodsReceipt_productionOutputId_key" ON "FinishedGoodsReceipt"("productionOutputId");
CREATE UNIQUE INDEX "FinishedGoodsReceipt_scanToken_key" ON "FinishedGoodsReceipt"("scanToken");
CREATE UNIQUE INDEX "FinishedGoodsReceipt_organizationId_number_key" ON "FinishedGoodsReceipt"("organizationId", "number");
CREATE INDEX "FinishedGoodsReceipt_organizationId_productionOrderId_status_idx" ON "FinishedGoodsReceipt"("organizationId", "productionOrderId", "status");
CREATE INDEX "FinishedGoodsReceipt_organizationId_batchId_idx" ON "FinishedGoodsReceipt"("organizationId", "batchId");
CREATE UNIQUE INDEX "FinishedGoodsReceiptTask_scanToken_key" ON "FinishedGoodsReceiptTask"("scanToken");
CREATE UNIQUE INDEX "FinishedGoodsReceiptTask_organizationId_number_key" ON "FinishedGoodsReceiptTask"("organizationId", "number");
CREATE INDEX "FinishedGoodsReceiptTask_organizationId_warehouseId_status_idx" ON "FinishedGoodsReceiptTask"("organizationId", "warehouseId", "status");
CREATE UNIQUE INDEX "FinishedGoodsReceiptDelivery_organizationId_idempotencyKey_key" ON "FinishedGoodsReceiptDelivery"("organizationId", "idempotencyKey");
CREATE INDEX "FinishedGoodsReceiptDelivery_taskId_receivedAt_idx" ON "FinishedGoodsReceiptDelivery"("taskId", "receivedAt");
CREATE INDEX "FinishedGoodsReceiptDiscrepancy_organizationId_taskId_idx" ON "FinishedGoodsReceiptDiscrepancy"("organizationId", "taskId");

ALTER TABLE "FinishedGoodsReceipt" ADD CONSTRAINT "FinishedGoodsReceipt_productionOutputId_fkey" FOREIGN KEY ("productionOutputId") REFERENCES "ProductionOutput"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinishedGoodsReceiptTask" ADD CONSTRAINT "FinishedGoodsReceiptTask_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "FinishedGoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinishedGoodsReceiptDelivery" ADD CONSTRAINT "FinishedGoodsReceiptDelivery_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "FinishedGoodsReceiptTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinishedGoodsReceiptDiscrepancy" ADD CONSTRAINT "FinishedGoodsReceiptDiscrepancy_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "FinishedGoodsReceiptTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing output remains governed by the previous automatic posting behavior.
-- No historical receipt rows are fabricated, preventing duplicate stock.
