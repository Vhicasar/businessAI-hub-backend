ALTER TABLE "ChannelAccount"
ADD COLUMN "metaWabaId" TEXT,
ADD COLUMN "metaPhoneNumberId" TEXT,
ADD COLUMN "metaFacebookPageId" TEXT,
ADD COLUMN "metaInstagramAccountId" TEXT;

UPDATE "ChannelAccount" SET "metaPhoneNumberId" = "externalId" WHERE "channelType" = 'WHATSAPP';
UPDATE "ChannelAccount" SET "metaFacebookPageId" = "externalId" WHERE "channelType" = 'FACEBOOK_MESSENGER';
UPDATE "ChannelAccount" SET "metaInstagramAccountId" = "externalId" WHERE "channelType" = 'INSTAGRAM';

CREATE UNIQUE INDEX "ChannelAccount_metaWabaId_key" ON "ChannelAccount"("metaWabaId");
CREATE UNIQUE INDEX "ChannelAccount_metaPhoneNumberId_key" ON "ChannelAccount"("metaPhoneNumberId");
CREATE UNIQUE INDEX "ChannelAccount_metaFacebookPageId_key" ON "ChannelAccount"("metaFacebookPageId");
CREATE UNIQUE INDEX "ChannelAccount_metaInstagramAccountId_key" ON "ChannelAccount"("metaInstagramAccountId");
