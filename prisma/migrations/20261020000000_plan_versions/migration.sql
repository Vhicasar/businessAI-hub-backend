-- CreateEnum
CREATE TYPE "MigrationTiming" AS ENUM ('IMMEDIATE', 'NEXT_RENEWAL');

-- CreateEnum
CREATE TYPE "MigrationPricing" AS ENUM ('KEEP_UNTIL_RENEWAL', 'APPLY_IMMEDIATELY', 'APPLY_AT_RENEWAL');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionChangeType" AS ENUM ('SUBSCRIBED', 'MIGRATED', 'UPGRADED', 'DOWNGRADED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "currentVersionId" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "grandfathered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pendingPlanVersionId" TEXT,
ADD COLUMN     "planVersionId" TEXT;

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "priceMonthly" DECIMAL(14,2) NOT NULL,
    "priceYearly" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "prices" JSONB,
    "maxUsers" INTEGER,
    "maxBranches" INTEGER,
    "maxProducts" INTEGER,
    "maxChannels" INTEGER,
    "maxContacts" INTEGER,
    "maxMarketingReach" INTEGER,
    "aiCreditsMonthly" INTEGER,
    "features" JSONB NOT NULL,
    "notes" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanMigration" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "fromVersionId" TEXT NOT NULL,
    "toVersionId" TEXT NOT NULL,
    "timing" "MigrationTiming" NOT NULL DEFAULT 'NEXT_RENEWAL',
    "pricing" "MigrationPricing" NOT NULL DEFAULT 'APPLY_AT_RENEWAL',
    "status" "MigrationStatus" NOT NULL DEFAULT 'PENDING',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "migratedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "initiatedByUserId" TEXT,
    "initiatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PlanMigration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionHistory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersionId" TEXT,
    "version" INTEGER,
    "priceMonthly" DECIMAL(14,2),
    "currency" CHAR(3),
    "interval" "PlanInterval",
    "changeType" "SubscriptionChangeType" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "migrationId" TEXT,
    "initiatedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanVersion_planId_publishedAt_idx" ON "PlanVersion"("planId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_planId_version_key" ON "PlanVersion"("planId", "version");

-- CreateIndex
CREATE INDEX "PlanMigration_planId_status_idx" ON "PlanMigration"("planId", "status");

-- CreateIndex
CREATE INDEX "SubscriptionHistory_organizationId_startedAt_idx" ON "SubscriptionHistory"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "SubscriptionHistory_subscriptionId_idx" ON "SubscriptionHistory"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_currentVersionId_key" ON "Plan"("currentVersionId");

-- AddForeignKey
ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanMigration" ADD CONSTRAINT "PlanMigration_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanMigration" ADD CONSTRAINT "PlanMigration_fromVersionId_fkey" FOREIGN KEY ("fromVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanMigration" ADD CONSTRAINT "PlanMigration_toVersionId_fkey" FOREIGN KEY ("toVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionHistory" ADD CONSTRAINT "SubscriptionHistory_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionHistory" ADD CONSTRAINT "SubscriptionHistory_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "PlanMigration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanVersionId_fkey" FOREIGN KEY ("pendingPlanVersionId") REFERENCES "PlanVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "FinishedGoodsReceipt_organizationId_productionOrderId_status_id" RENAME TO "FinishedGoodsReceipt_organizationId_productionOrderId_statu_idx";

-- RenameIndex
ALTER INDEX "ProductionMaterialIssue_organizationId_receiptIdempotencyKey_ke" RENAME TO "ProductionMaterialIssue_organizationId_receiptIdempotencyKe_key";

-- RenameIndex
ALTER INDEX "ProductionMaterialRequisition_organizationId_productionOrderId_" RENAME TO "ProductionMaterialRequisition_organizationId_productionOrde_idx";

-- RenameIndex
ALTER INDEX "ProductionMaterialRequisitionLine_requisitionId_productionMater" RENAME TO "ProductionMaterialRequisitionLine_requisitionId_productionM_key";

-- RenameIndex
ALTER INDEX "ProductionMaterialReturn_organizationId_receiptIdempotencyKey_k" RENAME TO "ProductionMaterialReturn_organizationId_receiptIdempotencyK_key";


-- ---------------------------------------------------------------------------
-- Backfill: every existing plan gets a v1, and every existing subscription is
-- pinned to it.
--
-- This is what makes the change invisible to businesses already subscribed.
-- Their v1 holds exactly what their plan row says today, so their price,
-- limits and features are unchanged at the moment of deployment — and from
-- here on, editing the plan no longer rewrites them.
-- ---------------------------------------------------------------------------

INSERT INTO "PlanVersion" (
  "id", "planId", "version", "priceMonthly", "priceYearly", "currency", "prices",
  "maxUsers", "maxBranches", "maxProducts", "maxChannels", "maxContacts",
  "maxMarketingReach", "aiCreditsMonthly", "features", "notes", "publishedAt", "createdAt"
)
SELECT
  'pv_' || replace(gen_random_uuid()::text, '-', ''),
  p."id", 1, p."priceMonthly", p."priceYearly", p."currency", p."prices",
  p."maxUsers", p."maxBranches", p."maxProducts", p."maxChannels", p."maxContacts",
  p."maxMarketingReach", p."aiCreditsMonthly", p."features",
  'Initial version, created from the plan as it stood when versioning was introduced.',
  NOW(), NOW()
FROM "Plan" p
WHERE NOT EXISTS (SELECT 1 FROM "PlanVersion" v WHERE v."planId" = p."id");

UPDATE "Plan" p
SET "currentVersionId" = v."id"
FROM "PlanVersion" v
WHERE v."planId" = p."id" AND v."version" = 1 AND p."currentVersionId" IS NULL;

UPDATE "Subscription" s
SET "planVersionId" = p."currentVersionId"
FROM "Plan" p
WHERE s."planId" = p."id" AND s."planVersionId" IS NULL;

-- A history row for what each subscription was already on, so the timeline
-- does not begin with a gap.
INSERT INTO "SubscriptionHistory" (
  "id", "organizationId", "subscriptionId", "planId", "planVersionId", "version",
  "priceMonthly", "currency", "interval", "changeType", "startedAt", "reason", "createdAt"
)
SELECT
  'sh_' || replace(gen_random_uuid()::text, '-', ''),
  s."organizationId", s."id", s."planId", s."planVersionId", 1,
  CASE WHEN s."interval" = 'YEARLY' THEN p."priceYearly" ELSE p."priceMonthly" END,
  p."currency", s."interval", 'SUBSCRIBED', s."createdAt",
  'Recorded when plan versioning was introduced.', NOW()
FROM "Subscription" s
JOIN "Plan" p ON p."id" = s."planId"
WHERE NOT EXISTS (SELECT 1 FROM "SubscriptionHistory" h WHERE h."subscriptionId" = s."id");
