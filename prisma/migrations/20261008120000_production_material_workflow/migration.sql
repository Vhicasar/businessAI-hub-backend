CREATE TYPE "MaterialIssueApprovalMode" AS ENUM ('NONE','SUPERVISOR','WAREHOUSE_MANAGER');
CREATE TYPE "MaterialRequisitionStatus" AS ENUM ('DRAFT','SUBMITTED','APPROVED','READY_FOR_ISSUE','PARTIALLY_ISSUED','ISSUED','PARTIALLY_RECEIVED','RECEIVED','REJECTED','CANCELLED');
CREATE TYPE "ProductionMaterialIssueStatus" AS ENUM ('READY_FOR_PICKING','PICKING','READY_FOR_HANDOVER','PARTIALLY_ISSUED','ISSUED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED');
CREATE TYPE "ProductionMaterialReturnStatus" AS ENUM ('AWAITING_WAREHOUSE_RECEIPT','RECEIVED','CANCELLED');

ALTER TABLE "ManufacturingSettings" ADD COLUMN "materialIssueApprovalMode" "MaterialIssueApprovalMode" NOT NULL DEFAULT 'NONE';
ALTER TABLE "ProductionMaterial" ADD COLUMN "receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0;
-- Existing direct-issue history predates receipt confirmation. Preserve its
-- ability to continue by treating already-issued legacy quantities as received.
UPDATE "ProductionMaterial" SET "receivedQuantity" = "issuedQuantity" WHERE "issuedQuantity" > 0;

CREATE TABLE "ProductionMaterialRequisition" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"number" TEXT NOT NULL,"productionOrderId" TEXT NOT NULL,"status" "MaterialRequisitionStatus" NOT NULL DEFAULT 'DRAFT',"requestedByUserId" TEXT,"requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"requiredAt" TIMESTAMP(3),"approvedByUserId" TEXT,"approvedAt" TIMESTAMP(3),"rejectedByUserId" TEXT,"rejectedAt" TIMESTAMP(3),"rejectionReason" TEXT,"notes" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "ProductionMaterialRequisition_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialRequisitionLine" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"requisitionId" TEXT NOT NULL,"productionMaterialId" TEXT NOT NULL,"variantId" TEXT NOT NULL,"requiredQuantity" DECIMAL(12,3) NOT NULL,"allocatedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,"shortageQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,"unit" TEXT,CONSTRAINT "ProductionMaterialRequisitionLine_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialAllocation" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"requisitionLineId" TEXT NOT NULL,"warehouseId" TEXT NOT NULL,"batchId" TEXT,"quantity" DECIMAL(12,3) NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "ProductionMaterialAllocation_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialIssue" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"number" TEXT NOT NULL,"productionOrderId" TEXT NOT NULL,"requisitionId" TEXT NOT NULL,"warehouseId" TEXT NOT NULL,"status" "ProductionMaterialIssueStatus" NOT NULL DEFAULT 'READY_FOR_PICKING',"scanToken" TEXT NOT NULL,"pickedByUserId" TEXT,"pickedAt" TIMESTAMP(3),"issuedByUserId" TEXT,"issuedAt" TIMESTAMP(3),"receivedByUserId" TEXT,"receivedAt" TIMESTAMP(3),"issueIdempotencyKey" TEXT,"receiptIdempotencyKey" TEXT,"notes" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "ProductionMaterialIssue_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialIssueLine" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"issueId" TEXT NOT NULL,"requisitionLineId" TEXT NOT NULL,"variantId" TEXT NOT NULL,"requestedQuantity" DECIMAL(12,3) NOT NULL,"pickedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,"issuedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,"receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,"varianceReason" TEXT,"notes" TEXT,CONSTRAINT "ProductionMaterialIssueLine_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialDiscrepancy" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"issueId" TEXT NOT NULL,"issueLineId" TEXT NOT NULL,"expectedQuantity" DECIMAL(12,3) NOT NULL,"reportedQuantity" DECIMAL(12,3) NOT NULL,"difference" DECIMAL(12,3) NOT NULL,"reason" TEXT NOT NULL,"notes" TEXT,"reportedByUserId" TEXT,"reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"resolvedAt" TIMESTAMP(3),CONSTRAINT "ProductionMaterialDiscrepancy_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialReturn" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"number" TEXT NOT NULL,"productionOrderId" TEXT NOT NULL,"warehouseId" TEXT NOT NULL,"status" "ProductionMaterialReturnStatus" NOT NULL DEFAULT 'AWAITING_WAREHOUSE_RECEIPT',"requestedByUserId" TEXT,"receivedByUserId" TEXT,"receivedAt" TIMESTAMP(3),"receiptIdempotencyKey" TEXT,"scanToken" TEXT NOT NULL,"notes" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "ProductionMaterialReturn_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProductionMaterialReturnLine" ("id" TEXT NOT NULL,"organizationId" TEXT NOT NULL,"returnId" TEXT NOT NULL,"variantId" TEXT NOT NULL,"requestedQuantity" DECIMAL(12,3) NOT NULL,"receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,CONSTRAINT "ProductionMaterialReturnLine_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "ProductionMaterialRequisition_organizationId_number_key" ON "ProductionMaterialRequisition"("organizationId","number");
CREATE INDEX "ProductionMaterialRequisition_organizationId_productionOrderId_idx" ON "ProductionMaterialRequisition"("organizationId","productionOrderId");
CREATE INDEX "ProductionMaterialRequisition_organizationId_status_idx" ON "ProductionMaterialRequisition"("organizationId","status");
CREATE UNIQUE INDEX "ProductionMaterialRequisitionLine_requisitionId_productionMaterialId_key" ON "ProductionMaterialRequisitionLine"("requisitionId","productionMaterialId");
CREATE INDEX "ProductionMaterialRequisitionLine_organizationId_variantId_idx" ON "ProductionMaterialRequisitionLine"("organizationId","variantId");
CREATE INDEX "ProductionMaterialAllocation_organizationId_warehouseId_idx" ON "ProductionMaterialAllocation"("organizationId","warehouseId");
CREATE INDEX "ProductionMaterialAllocation_requisitionLineId_idx" ON "ProductionMaterialAllocation"("requisitionLineId");
CREATE UNIQUE INDEX "ProductionMaterialIssue_scanToken_key" ON "ProductionMaterialIssue"("scanToken");
CREATE UNIQUE INDEX "ProductionMaterialIssue_organizationId_number_key" ON "ProductionMaterialIssue"("organizationId","number");
CREATE UNIQUE INDEX "ProductionMaterialIssue_organizationId_issueIdempotencyKey_key" ON "ProductionMaterialIssue"("organizationId","issueIdempotencyKey");
CREATE UNIQUE INDEX "ProductionMaterialIssue_organizationId_receiptIdempotencyKey_key" ON "ProductionMaterialIssue"("organizationId","receiptIdempotencyKey");
CREATE INDEX "ProductionMaterialIssue_organizationId_warehouseId_status_idx" ON "ProductionMaterialIssue"("organizationId","warehouseId","status");
CREATE INDEX "ProductionMaterialIssue_productionOrderId_idx" ON "ProductionMaterialIssue"("productionOrderId");
CREATE UNIQUE INDEX "ProductionMaterialIssueLine_issueId_requisitionLineId_key" ON "ProductionMaterialIssueLine"("issueId","requisitionLineId");
CREATE INDEX "ProductionMaterialIssueLine_organizationId_variantId_idx" ON "ProductionMaterialIssueLine"("organizationId","variantId");
CREATE INDEX "ProductionMaterialDiscrepancy_organizationId_issueId_idx" ON "ProductionMaterialDiscrepancy"("organizationId","issueId");
CREATE UNIQUE INDEX "ProductionMaterialReturn_scanToken_key" ON "ProductionMaterialReturn"("scanToken");
CREATE UNIQUE INDEX "ProductionMaterialReturn_organizationId_number_key" ON "ProductionMaterialReturn"("organizationId","number");
CREATE UNIQUE INDEX "ProductionMaterialReturn_organizationId_receiptIdempotencyKey_key" ON "ProductionMaterialReturn"("organizationId","receiptIdempotencyKey");
CREATE INDEX "ProductionMaterialReturn_organizationId_warehouseId_status_idx" ON "ProductionMaterialReturn"("organizationId","warehouseId","status");
CREATE INDEX "ProductionMaterialReturnLine_organizationId_variantId_idx" ON "ProductionMaterialReturnLine"("organizationId","variantId");

ALTER TABLE "ProductionMaterialRequisitionLine" ADD CONSTRAINT "ProductionMaterialRequisitionLine_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "ProductionMaterialRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductionMaterialAllocation" ADD CONSTRAINT "ProductionMaterialAllocation_requisitionLineId_fkey" FOREIGN KEY ("requisitionLineId") REFERENCES "ProductionMaterialRequisitionLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductionMaterialIssue" ADD CONSTRAINT "ProductionMaterialIssue_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "ProductionMaterialRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductionMaterialIssueLine" ADD CONSTRAINT "ProductionMaterialIssueLine_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ProductionMaterialIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductionMaterialIssueLine" ADD CONSTRAINT "ProductionMaterialIssueLine_requisitionLineId_fkey" FOREIGN KEY ("requisitionLineId") REFERENCES "ProductionMaterialRequisitionLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductionMaterialDiscrepancy" ADD CONSTRAINT "ProductionMaterialDiscrepancy_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ProductionMaterialIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductionMaterialReturnLine" ADD CONSTRAINT "ProductionMaterialReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ProductionMaterialReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
