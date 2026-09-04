-- CreateTable
CREATE TABLE "WarehouseAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "canManage" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarehouseAssignment_organizationId_idx" ON "WarehouseAssignment"("organizationId");

-- CreateIndex
CREATE INDEX "WarehouseAssignment_warehouseId_idx" ON "WarehouseAssignment"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseAssignment_membershipId_warehouseId_key" ON "WarehouseAssignment"("membershipId", "warehouseId");

-- AddForeignKey
ALTER TABLE "WarehouseAssignment" ADD CONSTRAINT "WarehouseAssignment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseAssignment" ADD CONSTRAINT "WarehouseAssignment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

