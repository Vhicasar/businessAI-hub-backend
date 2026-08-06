-- CreateEnum
CREATE TYPE "CustomerNotificationCategory" AS ENUM ('ORDER', 'PAYMENT', 'PROMOTION', 'BOOKING', 'REWARD', 'SUPPORT', 'DOCUMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CustomerDocumentKind" AS ENUM ('INVOICE', 'RECEIPT', 'QUOTATION', 'CONTRACT', 'PROPERTY_AGREEMENT', 'BOOKING_CONFIRMATION', 'WARRANTY', 'MEMBERSHIP_CERTIFICATE', 'INSPECTION_REPORT', 'OTHER');

-- CreateTable
CREATE TABLE "CustomerNotification" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "organizationId" TEXT,
    "category" "CustomerNotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerDocument" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "CustomerDocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "fileId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "amount" DECIMAL(14,2),
    "currency" CHAR(3),
    "isShareable" BOOLEAN NOT NULL DEFAULT true,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPreference" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "dashboardWidgets" TEXT[],
    "pinnedWidgets" TEXT[],
    "favouriteCategories" TEXT[],
    "defaultOrganizationId" TEXT,
    "paymentPriority" TEXT[],
    "theme" TEXT NOT NULL DEFAULT 'system',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "notificationPreferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerNotification_vhicasarId_readAt_createdAt_idx" ON "CustomerNotification"("vhicasarId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerNotification_vhicasarId_organizationId_idx" ON "CustomerNotification"("vhicasarId", "organizationId");

-- CreateIndex
CREATE INDEX "CustomerNotification_vhicasarId_category_idx" ON "CustomerNotification"("vhicasarId", "category");

-- CreateIndex
CREATE INDEX "CustomerDocument_vhicasarId_issuedAt_idx" ON "CustomerDocument"("vhicasarId", "issuedAt");

-- CreateIndex
CREATE INDEX "CustomerDocument_vhicasarId_kind_idx" ON "CustomerDocument"("vhicasarId", "kind");

-- CreateIndex
CREATE INDEX "CustomerDocument_organizationId_idx" ON "CustomerDocument"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPreference_vhicasarId_key" ON "CustomerPreference"("vhicasarId");
