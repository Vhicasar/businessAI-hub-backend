-- CreateEnum
CREATE TYPE "PayoutAccountType" AS ENUM ('BANK_ACCOUNT', 'MOBILE_MONEY');

-- CreateEnum
CREATE TYPE "PayoutAccountStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "AppRefreshToken" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "deviceId" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutAccount" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT,
    "organizationId" TEXT,
    "type" "PayoutAccountType" NOT NULL DEFAULT 'BANK_ACCOUNT',
    "status" "PayoutAccountStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "accountName" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "accountLast4" CHAR(4) NOT NULL,
    "bankCode" TEXT,
    "bankName" TEXT,
    "currency" CHAR(3) NOT NULL,
    "country" CHAR(2),
    "providerRef" TEXT,
    "provider" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT,
    "organizationId" TEXT,
    "payoutAccountId" TEXT NOT NULL,
    "settlementId" TEXT,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "feeAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(20,4) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "providerRef" TEXT,
    "failureReason" TEXT,
    "walletTransactionId" TEXT,
    "idempotencyKey" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycSubmission" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "level" "KycLevel" NOT NULL DEFAULT 'BASIC',
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "documentType" TEXT NOT NULL,
    "documentNumberEnc" TEXT NOT NULL,
    "documentFileId" TEXT,
    "selfieFileId" TEXT,
    "fullName" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "address" TEXT,
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentNonce" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "sessionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentNonce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppRefreshToken_tokenHash_key" ON "AppRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AppRefreshToken_vhicasarId_idx" ON "AppRefreshToken"("vhicasarId");

-- CreateIndex
CREATE INDEX "AppRefreshToken_familyId_idx" ON "AppRefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "PayoutAccount_vhicasarId_idx" ON "PayoutAccount"("vhicasarId");

-- CreateIndex
CREATE INDEX "PayoutAccount_organizationId_idx" ON "PayoutAccount"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_settlementId_key" ON "Payout"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_vhicasarId_status_idx" ON "Payout"("vhicasarId", "status");

-- CreateIndex
CREATE INDEX "Payout_organizationId_status_idx" ON "Payout"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Payout_providerRef_idx" ON "Payout"("providerRef");

-- CreateIndex
CREATE INDEX "KycSubmission_vhicasarId_status_idx" ON "KycSubmission"("vhicasarId", "status");

-- CreateIndex
CREATE INDEX "KycSubmission_status_submittedAt_idx" ON "KycSubmission"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "PaymentNonce_expiresAt_idx" ON "PaymentNonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentNonce_vhicasarId_nonce_key" ON "PaymentNonce"("vhicasarId", "nonce");

-- AddForeignKey
ALTER TABLE "AppRefreshToken" ADD CONSTRAINT "AppRefreshToken_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAccount" ADD CONSTRAINT "PayoutAccount_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAccount" ADD CONSTRAINT "PayoutAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_payoutAccountId_fkey" FOREIGN KEY ("payoutAccountId") REFERENCES "PayoutAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycSubmission" ADD CONSTRAINT "KycSubmission_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
