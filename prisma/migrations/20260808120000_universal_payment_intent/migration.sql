-- CreateEnum
CREATE TYPE "PaymentIntentResource" AS ENUM ('ORDER', 'INVOICE', 'DEAL', 'PROPERTY', 'PROPERTY_RESERVATION', 'BOOKING', 'SUBSCRIPTION', 'DEPOSIT', 'QUOTATION', 'RENT', 'INSPECTION_FEE', 'COMMISSION', 'INSTALMENT', 'POS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'AWAITING_PAYMENT', 'PROCESSING', 'PAID', 'PARTIALLY_PAID', 'OVERPAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentMethodKind" AS ENUM ('CARD', 'BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'USSD', 'QR_CODE', 'MOBILE_MONEY', 'PAYMENT_LINK', 'WALLET', 'DIRECT_DEBIT', 'PAY_WITH_BANK', 'APPLE_PAY', 'GOOGLE_PAY', 'PAYPAL', 'CRYPTO', 'CASH_ON_DELIVERY');

-- CreateEnum
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "VirtualAccountStatus" AS ENUM ('ACTIVE', 'DORMANT', 'CLOSED');

-- CreateEnum
CREATE TYPE "InboundWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "paymentIntentId" TEXT;

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "resourceType" "PaymentIntentResource" NOT NULL,
    "resourceId" TEXT,
    "customerId" TEXT,
    "orderId" TEXT,
    "invoiceId" TEXT,
    "dealId" TEXT,
    "propertyId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountRefunded" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
    "description" TEXT,
    "method" "PaymentMethodKind",
    "provider" TEXT,
    "allowPartial" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT,
    "channel" TEXT,
    "createdById" TEXT,
    "aiCreated" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "method" "PaymentMethodKind" NOT NULL,
    "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fee" DECIMAL(14,2),
    "rawPayload" JSONB,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethodSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "method" "PaymentMethodKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instructions" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethodSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCapability" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" "PaymentMethodKind" NOT NULL,
    "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minAmount" DECIMAL(14,2),
    "maxAmount" DECIMAL(14,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VirtualAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "VirtualAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VirtualAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT,
    "organizationId" TEXT,
    "paymentIntentId" TEXT,
    "status" "InboundWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboundWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_reference_key" ON "PaymentIntent"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_token_key" ON "PaymentIntent"("token");

-- CreateIndex
CREATE INDEX "PaymentIntent_organizationId_status_createdAt_idx" ON "PaymentIntent"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentIntent_customerId_idx" ON "PaymentIntent"("customerId");

-- CreateIndex
CREATE INDEX "PaymentIntent_resourceType_resourceId_idx" ON "PaymentIntent"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "PaymentIntent_orderId_idx" ON "PaymentIntent"("orderId");

-- CreateIndex
CREATE INDEX "PaymentIntent_invoiceId_idx" ON "PaymentIntent"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentIntent_dealId_idx" ON "PaymentIntent"("dealId");

-- CreateIndex
CREATE INDEX "PaymentIntent_expiresAt_idx" ON "PaymentIntent"("expiresAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_organizationId_status_createdAt_idx" ON "PaymentTransaction"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_paymentIntentId_idx" ON "PaymentTransaction"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_provider_providerRef_key" ON "PaymentTransaction"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "PaymentMethodSetting_organizationId_enabled_idx" ON "PaymentMethodSetting"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethodSetting_organizationId_method_key" ON "PaymentMethodSetting"("organizationId", "method");

-- CreateIndex
CREATE INDEX "ProviderCapability_provider_enabled_idx" ON "ProviderCapability"("provider", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCapability_provider_method_key" ON "ProviderCapability"("provider", "method");

-- CreateIndex
CREATE INDEX "VirtualAccount_organizationId_status_idx" ON "VirtualAccount"("organizationId", "status");

-- CreateIndex
CREATE INDEX "VirtualAccount_customerId_idx" ON "VirtualAccount"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualAccount_provider_accountNumber_key" ON "VirtualAccount"("provider", "accountNumber");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_status_receivedAt_idx" ON "InboundWebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_organizationId_receivedAt_idx" ON "InboundWebhookEvent"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_paymentIntentId_idx" ON "InboundWebhookEvent"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhookEvent_provider_eventKey_key" ON "InboundWebhookEvent"("provider", "eventKey");

-- CreateIndex
CREATE INDEX "Payment_paymentIntentId_idx" ON "Payment"("paymentIntentId");

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VirtualAccount" ADD CONSTRAINT "VirtualAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
