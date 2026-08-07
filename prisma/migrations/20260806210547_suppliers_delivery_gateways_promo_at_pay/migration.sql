-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "requiresDelivery" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PaymentSession" ADD COLUMN     "discountAmount" DECIMAL(14,2),
ADD COLUMN     "promotionId" TEXT;

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "notifyCustomers" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "cost" DECIMAL(14,2),
ADD COLUMN     "currency" CHAR(3),
ADD COLUMN     "dropoffAddress" TEXT,
ADD COLUMN     "estimatedAt" TIMESTAMP(3),
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "labelUrl" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "pickupAddress" TEXT,
ADD COLUMN     "providerId" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "recipientPhone" TEXT,
ADD COLUMN     "statusDetail" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "currency" CHAR(3),
ADD COLUMN     "leadTimeDays" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "taxId" TEXT,
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "SupplierContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "costPrice" DECIMAL(14,2),
    "currency" CHAR(3),
    "leadTimeDays" INTEGER,
    "minOrderQty" DECIMAL(12,3),
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryProvider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL DEFAULT 'MANUAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "credentials" JSONB,
    "settings" JSONB,
    "webhookSecret" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "externalEventId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "raw" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierContact_organizationId_supplierId_idx" ON "SupplierContact"("organizationId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierProduct_organizationId_productId_idx" ON "SupplierProduct"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_productId_key" ON "SupplierProduct"("supplierId", "productId");

-- CreateIndex
CREATE INDEX "DeliveryProvider_organizationId_isActive_idx" ON "DeliveryProvider"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryProvider_organizationId_name_key" ON "DeliveryProvider"("organizationId", "name");

-- CreateIndex
CREATE INDEX "DeliveryEvent_shipmentId_occurredAt_idx" ON "DeliveryEvent"("shipmentId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryEvent_shipmentId_externalEventId_key" ON "DeliveryEvent"("shipmentId", "externalEventId");

-- CreateIndex
CREATE INDEX "Shipment_providerId_externalId_idx" ON "Shipment"("providerId", "externalId");

-- AddForeignKey
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
