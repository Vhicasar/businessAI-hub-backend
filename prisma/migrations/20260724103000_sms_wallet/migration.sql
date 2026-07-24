CREATE TYPE "SmsWalletTransactionType" AS ENUM ('PURCHASE', 'SEND', 'ROLLBACK', 'ADJUSTMENT');

CREATE TABLE "SmsWallet" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "balance" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
  "lowBalanceThreshold" DECIMAL(14,4) NOT NULL DEFAULT 500,
  "lastLowBalanceAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsWallet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsWallet_organizationId_key" ON "SmsWallet"("organizationId");
ALTER TABLE "SmsWallet" ADD CONSTRAINT "SmsWallet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SmsWalletTransaction" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "type" "SmsWalletTransactionType" NOT NULL,
  "amount" DECIMAL(14,4) NOT NULL,
  "balanceAfter" DECIMAL(14,4) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "description" TEXT NOT NULL,
  "reference" TEXT,
  "campaignId" TEXT,
  "customerId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsWalletTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsWalletTransaction_organizationId_reference_key" ON "SmsWalletTransaction"("organizationId", "reference");
CREATE INDEX "SmsWalletTransaction_organizationId_createdAt_idx" ON "SmsWalletTransaction"("organizationId", "createdAt");
CREATE INDEX "SmsWalletTransaction_walletId_idx" ON "SmsWalletTransaction"("walletId");
ALTER TABLE "SmsWalletTransaction" ADD CONSTRAINT "SmsWalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "SmsWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
