-- WhatsApp marketing campaigns: per-recipient provider tracking and the
-- dispatch states a partially-sent campaign needs.
--
-- Additive only. Existing campaigns keep their status; existing recipient
-- rows get nulls and a zero attempt count, which is exactly what they mean.

ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_SENT';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "errorCode" INTEGER;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_providerMessageId_idx" ON "CampaignRecipient"("providerMessageId");
