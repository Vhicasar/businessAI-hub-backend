-- CreateEnum
CREATE TYPE "RewardLedgerType" AS ENUM ('EARN', 'REDEEM', 'EXPIRE', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "RewardTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

-- CreateTable
CREATE TABLE "RewardAccount" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime" INTEGER NOT NULL DEFAULT 0,
    "tier" "RewardTier" NOT NULL DEFAULT 'BRONZE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardLedger" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "type" "RewardLedgerType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "organizationId" TEXT,
    "paymentId" TEXT,
    "description" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardAccount_vhicasarId_key" ON "RewardAccount"("vhicasarId");

-- CreateIndex
CREATE INDEX "RewardAccount_tier_idx" ON "RewardAccount"("tier");

-- CreateIndex
CREATE INDEX "RewardLedger_vhicasarId_createdAt_idx" ON "RewardLedger"("vhicasarId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardLedger_accountId_createdAt_idx" ON "RewardLedger"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardLedger_type_expiresAt_idx" ON "RewardLedger"("type", "expiresAt");

-- AddForeignKey
ALTER TABLE "RewardLedger" ADD CONSTRAINT "RewardLedger_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "RewardAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
