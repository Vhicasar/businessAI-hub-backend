-- CreateEnum
CREATE TYPE "TransactionAuthMode" AS ENUM ('PIN_ONLY', 'BIOMETRIC_ONLY', 'PIN_AND_BIOMETRIC', 'ADAPTIVE');

-- CreateEnum
CREATE TYPE "SettlementAccountType" AS ENUM ('BANK_ACCOUNT', 'VIRTUAL_ACCOUNT', 'DIGITAL_WALLET');

-- CreateEnum
CREATE TYPE "SettlementAccountStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'BLACKLISTED');

-- CreateEnum
CREATE TYPE "SettlementSchedule" AS ENUM ('INSTANT', 'HOURLY', 'DAILY', 'WEEKLY', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BusinessQrKind" ADD VALUE 'EMPLOYEE';
ALTER TYPE "BusinessQrKind" ADD VALUE 'TABLE';
ALTER TYPE "BusinessQrKind" ADD VALUE 'PROPERTY';
ALTER TYPE "BusinessQrKind" ADD VALUE 'PRODUCT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SettlementStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "SettlementStatus" ADD VALUE 'ON_HOLD';
ALTER TYPE "SettlementStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "BusinessQr" ADD COLUMN     "joinCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subjectId" TEXT,
ADD COLUMN     "subjectLabel" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reserveAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "reserveReleaseAt" TIMESTAMP(3),
ADD COLUMN     "riskScore" INTEGER,
ADD COLUMN     "scheduledFor" TIMESTAMP(3),
ADD COLUMN     "secondApprovedAt" TIMESTAMP(3),
ADD COLUMN     "secondApproverUserId" TEXT,
ADD COLUMN     "settlementAccountId" TEXT,
ADD COLUMN     "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TransactionSecurity" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "pinHash" TEXT,
    "pinLength" INTEGER,
    "authMode" "TransactionAuthMode" NOT NULL DEFAULT 'ADAPTIVE',
    "isBiometricEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "highValueThreshold" DECIMAL(14,2),
    "trustedDeviceIds" TEXT[],
    "pinUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionSecurity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinResetToken" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerLocation" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "country" CHAR(2),
    "region" TEXT,
    "city" TEXT,
    "timeZone" TEXT,
    "currency" CHAR(3),
    "locale" TEXT,
    "source" TEXT NOT NULL,
    "consentLevel" TEXT NOT NULL DEFAULT 'NONE',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrScanEvent" (
    "id" TEXT NOT NULL,
    "businessQrId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "vhicasarId" TEXT,
    "didJoin" BOOLEAN NOT NULL DEFAULT false,
    "country" CHAR(2),
    "city" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "businessUnit" TEXT,
    "type" "SettlementAccountType" NOT NULL DEFAULT 'BANK_ACCOUNT',
    "status" "SettlementAccountStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "bankName" TEXT,
    "bankCode" TEXT,
    "accountNumberEnc" TEXT NOT NULL,
    "accountFingerprint" TEXT NOT NULL,
    "accountLast4" CHAR(4) NOT NULL,
    "accountName" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "verifiedName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationRef" TEXT,
    "rejectionReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SettlementAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementAccountChange" (
    "id" TEXT NOT NULL,
    "settlementAccountId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorUserId" TEXT,
    "ip" TEXT,
    "deviceId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementAccountChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "currency" CHAR(3),
    "schedule" "SettlementSchedule" NOT NULL DEFAULT 'DAILY',
    "runAtHour" INTEGER NOT NULL DEFAULT 2,
    "runOnWeekday" INTEGER,
    "feePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "feeFlat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxPercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "reservePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "reserveDays" INTEGER NOT NULL DEFAULT 0,
    "minimumAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "approvalThreshold" DECIMAL(14,2),
    "requiresDualApproval" BOOLEAN NOT NULL DEFAULT false,
    "delayHours" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiReplySuggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "wasEdited" BOOLEAN NOT NULL DEFAULT false,
    "requestedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiReplySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionSecurity_vhicasarId_key" ON "TransactionSecurity"("vhicasarId");

-- CreateIndex
CREATE UNIQUE INDEX "PinResetToken_tokenHash_key" ON "PinResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PinResetToken_vhicasarId_expiresAt_idx" ON "PinResetToken"("vhicasarId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerLocation_vhicasarId_key" ON "CustomerLocation"("vhicasarId");

-- CreateIndex
CREATE INDEX "QrScanEvent_businessQrId_createdAt_idx" ON "QrScanEvent"("businessQrId", "createdAt");

-- CreateIndex
CREATE INDEX "QrScanEvent_organizationId_createdAt_idx" ON "QrScanEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementAccount_organizationId_status_idx" ON "SettlementAccount"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SettlementAccount_accountFingerprint_idx" ON "SettlementAccount"("accountFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAccount_organizationId_accountFingerprint_key" ON "SettlementAccount"("organizationId", "accountFingerprint");

-- CreateIndex
CREATE INDEX "SettlementAccountChange_organizationId_createdAt_idx" ON "SettlementAccountChange"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementAccountChange_settlementAccountId_createdAt_idx" ON "SettlementAccountChange"("settlementAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementRule_organizationId_isActive_idx" ON "SettlementRule"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRule_organizationId_branchId_currency_key" ON "SettlementRule"("organizationId", "branchId", "currency");

-- CreateIndex
CREATE INDEX "AiReplySuggestion_organizationId_conversationId_createdAt_idx" ON "AiReplySuggestion"("organizationId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Settlement_status_scheduledFor_idx" ON "Settlement"("status", "scheduledFor");

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_settlementAccountId_fkey" FOREIGN KEY ("settlementAccountId") REFERENCES "SettlementAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionSecurity" ADD CONSTRAINT "TransactionSecurity_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLocation" ADD CONSTRAINT "CustomerLocation_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrScanEvent" ADD CONSTRAINT "QrScanEvent_businessQrId_fkey" FOREIGN KEY ("businessQrId") REFERENCES "BusinessQr"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAccount" ADD CONSTRAINT "SettlementAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAccountChange" ADD CONSTRAINT "SettlementAccountChange_settlementAccountId_fkey" FOREIGN KEY ("settlementAccountId") REFERENCES "SettlementAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRule" ADD CONSTRAINT "SettlementRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
