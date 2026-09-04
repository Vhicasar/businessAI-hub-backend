-- CreateEnum
CREATE TYPE "ManufacturingType" AS ENUM ('RAW_MATERIAL', 'PACKAGING', 'WORK_IN_PROGRESS', 'FINISHED_GOOD', 'SPARE_PART', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('GENERAL', 'RAW_MATERIAL', 'PACKAGING', 'WORK_IN_PROGRESS', 'FINISHED_GOODS', 'SPARE_PARTS', 'QUARANTINE');

-- CreateEnum
CREATE TYPE "BomStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductionPlanStatus" AS ENUM ('DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ProductionLineStatus" AS ENUM ('OPERATIONAL', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'OFFLINE');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('OPERATIONAL', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'RETIRED');

-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'CONDITIONAL');

-- CreateEnum
CREATE TYPE "QuarantineStatus" AS ENUM ('HELD', 'RELEASED', 'REJECTED', 'REWORK', 'DISPOSED');

-- AlterEnum
ALTER TYPE "MaintenanceStatus" ADD VALUE 'ASSIGNED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'MATERIAL_ISSUE';
ALTER TYPE "StockMovementType" ADD VALUE 'MATERIAL_CONSUMPTION';
ALTER TYPE "StockMovementType" ADD VALUE 'MATERIAL_RETURN';
ALTER TYPE "StockMovementType" ADD VALUE 'EXPIRED';
ALTER TYPE "StockMovementType" ADD VALUE 'QC_QUARANTINE';
ALTER TYPE "StockMovementType" ADD VALUE 'QC_RELEASE';
ALTER TYPE "StockMovementType" ADD VALUE 'QC_REJECTION';
ALTER TYPE "StockMovementType" ADD VALUE 'MAINTENANCE_CONSUMPTION';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "batchTracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expiryTracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manufacturingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manufacturingType" "ManufacturingType",
ADD COLUMN     "maxStock" DECIMAL(12,3),
ADD COLUMN     "minStock" DECIMAL(12,3),
ADD COLUMN     "purchaseEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "safetyStock" DECIMAL(12,3),
ADD COLUMN     "sellable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "serialTracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "standardCost" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "warehouseType" "WarehouseType" NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE "ManufacturingSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "allowMultipleActiveBoms" BOOLEAN NOT NULL DEFAULT false,
    "acceptableVariancePercent" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "batchNumberFormat" TEXT NOT NULL DEFAULT '{SKU}-{YYYYMMDD}-{SEQ}',
    "requireQcBeforeRelease" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManufacturingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillOfMaterial" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bomNumber" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "BomStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "outputQuantity" DECIMAL(12,3) NOT NULL,
    "warehouseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BillOfMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillOfMaterialItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "scrapPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "BillOfMaterialItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionPlan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planNumber" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "bomId" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "productionDate" TIMESTAMP(3) NOT NULL,
    "expectedCompletionDate" TIMESTAMP(3),
    "productionLineId" TEXT,
    "warehouseId" TEXT,
    "priority" "ProductionPriority" NOT NULL DEFAULT 'NORMAL',
    "responsibleEmployeeId" TEXT,
    "status" "ProductionPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "planId" TEXT,
    "productId" TEXT NOT NULL,
    "bomId" TEXT,
    "plannedQuantity" DECIMAL(12,3) NOT NULL,
    "actualQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejectedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "productionLineId" TEXT,
    "warehouseId" TEXT,
    "finishedWarehouseId" TEXT,
    "startDate" TIMESTAMP(3),
    "expectedCompletionDate" TIMESTAMP(3),
    "actualCompletionDate" TIMESTAMP(3),
    "responsibleEmployeeId" TEXT,
    "status" "ProductionOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "ProductionPriority" NOT NULL DEFAULT 'NORMAL',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionMaterial" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "requiredQuantity" DECIMAL(12,3) NOT NULL,
    "issuedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "consumedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit" TEXT,

    CONSTRAINT "ProductionMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialConsumption" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "requiredQuantity" DECIMAL(12,3),
    "issuedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "consumedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "batchId" TEXT,
    "batchNumber" TEXT,
    "issuedByUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "MaterialConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOutput" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "plannedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "producedQuantity" DECIMAL(12,3) NOT NULL,
    "rejectedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "goodQuantity" DECIMAL(12,3) NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "batchId" TEXT,
    "productionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiryDate" TIMESTAMP(3),
    "responsibleEmployeeId" TEXT,
    "recordedByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productionOrderId" TEXT,
    "productionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiryDate" TIMESTAMP(3),
    "quantityProduced" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "quantityAvailable" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "warehouseId" TEXT,
    "qcStatus" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "isQuarantined" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityParameter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "expectedMin" DECIMAL(14,4),
    "expectedMax" DECIMAL(14,4),
    "expectedText" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "QualityParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityInspection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "inspectionNumber" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "batchId" TEXT,
    "productionOrderId" TEXT,
    "inspectorUserId" TEXT,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityInspectionItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "parameterId" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "expectedMin" DECIMAL(14,4),
    "expectedMax" DECIMAL(14,4),
    "expectedText" TEXT,
    "actualValue" TEXT,
    "actualNumeric" DECIMAL(14,4),
    "passed" BOOLEAN,

    CONSTRAINT "QualityInspectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuarantineRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "QuarantineStatus" NOT NULL DEFAULT 'HELD',
    "heldByUserId" TEXT,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuarantineRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "location" TEXT,
    "capacity" DECIMAL(12,3),
    "capacityUnit" TEXT,
    "status" "ProductionLineStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "responsibleEmployeeId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT,
    "productionLineId" TEXT,
    "location" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "warrantyExpiry" TIMESTAMP(3),
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "maintenanceFrequencyDays" INTEGER,
    "lastMaintenanceAt" TIMESTAMP(3),
    "nextMaintenanceAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceWorkOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workOrderNumber" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "type" "MaintenanceType" NOT NULL DEFAULT 'CORRECTIVE',
    "issue" TEXT NOT NULL,
    "priority" "MaintenancePriority" NOT NULL DEFAULT 'MEDIUM',
    "assignedEmployeeId" TEXT,
    "startDate" TIMESTAMP(3),
    "completionDate" TIMESTAMP(3),
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'OPEN',
    "downtimeMinutes" INTEGER,
    "cost" DECIMAL(14,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MaintenanceWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePart" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(14,2),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenancePart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionCost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "materialCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "packagingCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "labourCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overheadCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,4),
    "estimatedCost" DECIMAL(14,2),
    "estimatedUnitCost" DECIMAL(14,4),
    "currency" CHAR(3) NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionVariance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "plannedQuantity" DECIMAL(12,3) NOT NULL,
    "actualQuantity" DECIMAL(12,3) NOT NULL,
    "varianceQuantity" DECIMAL(12,3) NOT NULL,
    "variancePercent" DECIMAL(8,2),
    "exceedsThreshold" BOOLEAN NOT NULL DEFAULT false,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionVariance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingSettings_organizationId_key" ON "ManufacturingSettings"("organizationId");

-- CreateIndex
CREATE INDEX "BillOfMaterial_organizationId_productId_status_idx" ON "BillOfMaterial"("organizationId", "productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillOfMaterial_organizationId_bomNumber_key" ON "BillOfMaterial"("organizationId", "bomNumber");

-- CreateIndex
CREATE INDEX "BillOfMaterialItem_organizationId_idx" ON "BillOfMaterialItem"("organizationId");

-- CreateIndex
CREATE INDEX "BillOfMaterialItem_bomId_idx" ON "BillOfMaterialItem"("bomId");

-- CreateIndex
CREATE INDEX "ProductionPlan_organizationId_status_productionDate_idx" ON "ProductionPlan"("organizationId", "status", "productionDate");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionPlan_organizationId_planNumber_key" ON "ProductionPlan"("organizationId", "planNumber");

-- CreateIndex
CREATE INDEX "ProductionOrder_organizationId_status_idx" ON "ProductionOrder"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ProductionOrder_organizationId_productId_idx" ON "ProductionOrder"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_organizationId_orderNumber_key" ON "ProductionOrder"("organizationId", "orderNumber");

-- CreateIndex
CREATE INDEX "ProductionMaterial_organizationId_idx" ON "ProductionMaterial"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionMaterial_productionOrderId_variantId_key" ON "ProductionMaterial"("productionOrderId", "variantId");

-- CreateIndex
CREATE INDEX "MaterialConsumption_organizationId_occurredAt_idx" ON "MaterialConsumption"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "MaterialConsumption_productionOrderId_idx" ON "MaterialConsumption"("productionOrderId");

-- CreateIndex
CREATE INDEX "ProductionOutput_organizationId_productionDate_idx" ON "ProductionOutput"("organizationId", "productionDate");

-- CreateIndex
CREATE INDEX "ProductionOutput_productionOrderId_idx" ON "ProductionOutput"("productionOrderId");

-- CreateIndex
CREATE INDEX "Batch_organizationId_qcStatus_idx" ON "Batch"("organizationId", "qcStatus");

-- CreateIndex
CREATE INDEX "Batch_variantId_idx" ON "Batch"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_organizationId_batchNumber_key" ON "Batch"("organizationId", "batchNumber");

-- CreateIndex
CREATE INDEX "QualityParameter_organizationId_productId_idx" ON "QualityParameter"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "QualityInspection_organizationId_status_idx" ON "QualityInspection"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QualityInspection_organizationId_inspectionNumber_key" ON "QualityInspection"("organizationId", "inspectionNumber");

-- CreateIndex
CREATE INDEX "QualityInspectionItem_organizationId_idx" ON "QualityInspectionItem"("organizationId");

-- CreateIndex
CREATE INDEX "QualityInspectionItem_inspectionId_idx" ON "QualityInspectionItem"("inspectionId");

-- CreateIndex
CREATE INDEX "QuarantineRecord_organizationId_status_idx" ON "QuarantineRecord"("organizationId", "status");

-- CreateIndex
CREATE INDEX "QuarantineRecord_batchId_idx" ON "QuarantineRecord"("batchId");

-- CreateIndex
CREATE INDEX "ProductionLine_organizationId_status_idx" ON "ProductionLine"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionLine_organizationId_code_key" ON "ProductionLine"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Equipment_organizationId_status_idx" ON "Equipment"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_organizationId_code_key" ON "Equipment"("organizationId", "code");

-- CreateIndex
CREATE INDEX "MaintenanceWorkOrder_organizationId_status_idx" ON "MaintenanceWorkOrder"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceWorkOrder_equipmentId_idx" ON "MaintenanceWorkOrder"("equipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceWorkOrder_organizationId_workOrderNumber_key" ON "MaintenanceWorkOrder"("organizationId", "workOrderNumber");

-- CreateIndex
CREATE INDEX "MaintenancePart_organizationId_idx" ON "MaintenancePart"("organizationId");

-- CreateIndex
CREATE INDEX "MaintenancePart_workOrderId_idx" ON "MaintenancePart"("workOrderId");

-- CreateIndex
CREATE INDEX "ProductionCost_organizationId_calculatedAt_idx" ON "ProductionCost"("organizationId", "calculatedAt");

-- CreateIndex
CREATE INDEX "ProductionCost_productionOrderId_idx" ON "ProductionCost"("productionOrderId");

-- CreateIndex
CREATE INDEX "ProductionVariance_organizationId_calculatedAt_idx" ON "ProductionVariance"("organizationId", "calculatedAt");

-- CreateIndex
CREATE INDEX "ProductionVariance_productionOrderId_idx" ON "ProductionVariance"("productionOrderId");

-- AddForeignKey
ALTER TABLE "BillOfMaterial" ADD CONSTRAINT "BillOfMaterial_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillOfMaterial" ADD CONSTRAINT "BillOfMaterial_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillOfMaterialItem" ADD CONSTRAINT "BillOfMaterialItem_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "BillOfMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillOfMaterialItem" ADD CONSTRAINT "BillOfMaterialItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionPlan" ADD CONSTRAINT "ProductionPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionPlan" ADD CONSTRAINT "ProductionPlan_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "BillOfMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionPlan" ADD CONSTRAINT "ProductionPlan_productionLineId_fkey" FOREIGN KEY ("productionLineId") REFERENCES "ProductionLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionPlan" ADD CONSTRAINT "ProductionPlan_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ProductionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "BillOfMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_productionLineId_fkey" FOREIGN KEY ("productionLineId") REFERENCES "ProductionLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMaterial" ADD CONSTRAINT "ProductionMaterial_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMaterial" ADD CONSTRAINT "ProductionMaterial_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialConsumption" ADD CONSTRAINT "MaterialConsumption_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialConsumption" ADD CONSTRAINT "MaterialConsumption_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialConsumption" ADD CONSTRAINT "MaterialConsumption_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialConsumption" ADD CONSTRAINT "MaterialConsumption_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOutput" ADD CONSTRAINT "ProductionOutput_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOutput" ADD CONSTRAINT "ProductionOutput_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOutput" ADD CONSTRAINT "ProductionOutput_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOutput" ADD CONSTRAINT "ProductionOutput_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityParameter" ADD CONSTRAINT "QualityParameter_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspectionItem" ADD CONSTRAINT "QualityInspectionItem_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "QualityInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuarantineRecord" ADD CONSTRAINT "QuarantineRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_productionLineId_fkey" FOREIGN KEY ("productionLineId") REFERENCES "ProductionLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWorkOrder" ADD CONSTRAINT "MaintenanceWorkOrder_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePart" ADD CONSTRAINT "MaintenancePart_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MaintenanceWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePart" ADD CONSTRAINT "MaintenancePart_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionCost" ADD CONSTRAINT "ProductionCost_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

