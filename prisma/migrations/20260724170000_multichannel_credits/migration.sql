ALTER TABLE "SmsWalletTransaction"
ADD COLUMN "channelType" "ChannelType" NOT NULL DEFAULT 'SMS';

CREATE INDEX "SmsWalletTransaction_organizationId_channelType_createdAt_idx"
ON "SmsWalletTransaction"("organizationId", "channelType", "createdAt");
