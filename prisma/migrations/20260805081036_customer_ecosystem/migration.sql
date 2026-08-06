-- CreateEnum
CREATE TYPE "BusinessQrKind" AS ENUM ('PERMANENT', 'BRANCH', 'EVENT', 'REFERRAL', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "LoyaltyTrigger" AS ENUM ('POS_SALE', 'ORDER', 'BOOKING', 'INVOICE_PAYMENT', 'WALLET_PAYMENT', 'CARD_PAYMENT', 'BANK_TRANSFER', 'CASH_SALE', 'CAMPAIGN', 'REFERRAL', 'MANUAL', 'BIRTHDAY', 'ANNIVERSARY', 'SIGNUP');

-- CreateEnum
CREATE TYPE "RewardCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "RewardGrantStatus" AS ENUM ('PENDING_REVIEW', 'GRANTED', 'REJECTED', 'EXPIRED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WalletBucket" AS ENUM ('AVAILABLE', 'LOCKED', 'REWARD', 'CASHBACK');

-- AlterTable
ALTER TABLE "CustomerLink" ADD COLUMN     "isFavourite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastAccessedAt" TIMESTAMP(3),
ADD COLUMN     "unreadPromotions" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "audience" JSONB,
ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "budget" DECIMAL(14,2),
ADD COLUMN     "budgetSpent" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'DISCOUNT',
ADD COLUMN     "maxPerCustomer" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "maxRedemptions" INTEGER,
ADD COLUMN     "minSpend" DECIMAL(14,2),
ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "notifyAt" TIMESTAMP(3),
ADD COLUMN     "redemptionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "schedule" JSONB,
ADD COLUMN     "terms" TEXT;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "cashbackBalance" DECIMAL(20,4) NOT NULL DEFAULT 0,
ADD COLUMN     "lockedBalance" DECIMAL(20,4) NOT NULL DEFAULT 0,
ADD COLUMN     "rewardBalance" DECIMAL(20,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "handle" TEXT,
    "tagline" TEXT,
    "description" TEXT,
    "coverImageUrl" TEXT,
    "category" TEXT,
    "tags" TEXT[],
    "openingHours" JSONB,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT true,
    "allowSelfLeave" BOOLEAN NOT NULL DEFAULT true,
    "acceptsLockedFunds" BOOLEAN NOT NULL DEFAULT true,
    "services" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessQr" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "kind" "BusinessQrKind" NOT NULL DEFAULT 'PERMANENT',
    "code" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "label" TEXT,
    "campaignId" TEXT,
    "referrerCustomerId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "maxScans" INTEGER,
    "scanCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessQr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyRule" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "LoyaltyTrigger" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pointsPerAmount" DECIMAL(10,4),
    "flatPoints" INTEGER,
    "multiplier" DECIMAL(6,2),
    "minSpend" DECIMAL(14,2),
    "maxPointsPerDay" INTEGER,
    "eligibility" JSONB,
    "tier" TEXT,
    "branchId" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRedemption" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vhicasarId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "benefitAmount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RewardCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "rewardAmount" DECIMAL(14,2),
    "rewardPercent" DECIMAL(6,3),
    "maxRewardPerTxn" DECIMAL(14,2),
    "minSpend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "maxRewardsPerDay" INTEGER,
    "maxRewardsPerMonth" INTEGER,
    "budget" DECIMAL(16,2),
    "budgetSpent" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "eligibleOrganizationIds" TEXT[],
    "eligibleCategories" TEXT[],
    "eligibleCountries" TEXT[],
    "targetBucket" "WalletBucket" NOT NULL DEFAULT 'REWARD',
    "rewardExpiryDays" INTEGER,
    "fundingSource" TEXT NOT NULL DEFAULT 'PLATFORM',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardGrant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "organizationId" TEXT,
    "paymentId" TEXT,
    "spendAmount" DECIMAL(14,2) NOT NULL,
    "rewardAmount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "RewardGrantStatus" NOT NULL DEFAULT 'GRANTED',
    "riskScore" INTEGER,
    "reviewNotes" TEXT,
    "walletTransactionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "RewardGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerBusinessPreference" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notifyPromotions" BOOLEAN NOT NULL DEFAULT true,
    "notifyOrders" BOOLEAN NOT NULL DEFAULT true,
    "notifyLoyalty" BOOLEAN NOT NULL DEFAULT true,
    "paymentPriority" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerBusinessPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerBusinessHistory" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT,
    "qrCode" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerBusinessHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_organizationId_key" ON "BusinessProfile"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_handle_key" ON "BusinessProfile"("handle");

-- CreateIndex
CREATE INDEX "BusinessProfile_category_idx" ON "BusinessProfile"("category");

-- CreateIndex
CREATE INDEX "BusinessProfile_isDiscoverable_idx" ON "BusinessProfile"("isDiscoverable");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessQr_code_key" ON "BusinessQr"("code");

-- CreateIndex
CREATE INDEX "BusinessQr_organizationId_kind_idx" ON "BusinessQr"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "BusinessQr_code_idx" ON "BusinessQr"("code");

-- CreateIndex
CREATE INDEX "LoyaltyRule_organizationId_trigger_isActive_idx" ON "LoyaltyRule"("organizationId", "trigger", "isActive");

-- CreateIndex
CREATE INDEX "LoyaltyRule_programId_idx" ON "LoyaltyRule"("programId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_organizationId_promotionId_idx" ON "PromotionRedemption"("organizationId", "promotionId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_promotionId_customerId_idx" ON "PromotionRedemption"("promotionId", "customerId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_customerId_idx" ON "PromotionRedemption"("customerId");

-- CreateIndex
CREATE INDEX "RewardCampaign_status_startsAt_idx" ON "RewardCampaign"("status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardGrant_idempotencyKey_key" ON "RewardGrant"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RewardGrant_vhicasarId_createdAt_idx" ON "RewardGrant"("vhicasarId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardGrant_campaignId_status_idx" ON "RewardGrant"("campaignId", "status");

-- CreateIndex
CREATE INDEX "RewardGrant_organizationId_idx" ON "RewardGrant"("organizationId");

-- CreateIndex
CREATE INDEX "CustomerBusinessPreference_organizationId_idx" ON "CustomerBusinessPreference"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerBusinessPreference_vhicasarId_organizationId_key" ON "CustomerBusinessPreference"("vhicasarId", "organizationId");

-- CreateIndex
CREATE INDEX "CustomerBusinessHistory_vhicasarId_createdAt_idx" ON "CustomerBusinessHistory"("vhicasarId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerBusinessHistory_organizationId_createdAt_idx" ON "CustomerBusinessHistory"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Promotion_organizationId_startsAt_endsAt_idx" ON "Promotion"("organizationId", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessQr" ADD CONSTRAINT "BusinessQr_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRule" ADD CONSTRAINT "LoyaltyRule_programId_fkey" FOREIGN KEY ("programId") REFERENCES "LoyaltyProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardGrant" ADD CONSTRAINT "RewardGrant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "RewardCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
