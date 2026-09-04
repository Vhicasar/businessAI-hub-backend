-- AlterTable
ALTER TABLE "MaintenanceWorkOrder" ADD COLUMN     "scanToken" TEXT;

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN     "scanToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceWorkOrder_scanToken_key" ON "MaintenanceWorkOrder"("scanToken");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_scanToken_key" ON "ProductionOrder"("scanToken");

