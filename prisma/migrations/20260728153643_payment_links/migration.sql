-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentLinkResource" AS ENUM ('ORDER', 'INVOICE', 'PROPERTY_PURCHASE', 'PROPERTY_RESERVATION', 'BOOKING', 'QUOTATION', 'SUBSCRIPTION', 'DEPOSIT', 'CUSTOM');

-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "resourceType" "PaymentLinkResource" NOT NULL,
    "resourceId" TEXT,
    "customerId" TEXT,
    "token" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "description" TEXT,
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'PENDING',
    "allowPartial" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerRef" TEXT,
    "createdById" TEXT,
    "metadata" JSONB,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_token_key" ON "PaymentLink"("token");

-- CreateIndex
CREATE INDEX "PaymentLink_organizationId_status_createdAt_idx" ON "PaymentLink"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentLink_customerId_idx" ON "PaymentLink"("customerId");

-- CreateIndex
CREATE INDEX "PaymentLink_resourceType_resourceId_idx" ON "PaymentLink"("resourceType", "resourceId");
