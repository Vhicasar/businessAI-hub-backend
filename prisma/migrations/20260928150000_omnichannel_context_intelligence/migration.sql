ALTER TABLE "Message"
  ADD COLUMN "normalizedType" TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN "providerMetadata" JSONB,
  ADD COLUMN "contextSnapshot" JSONB;

CREATE TABLE "ProductExternalReference" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "url" TEXT,
  "catalogId" TEXT,
  "campaignId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductExternalReference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductExternalReference_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProductExternalReference_organizationId_channel_externalId_key"
  ON "ProductExternalReference"("organizationId", "channel", "externalId");
CREATE INDEX "ProductExternalReference_organizationId_url_idx"
  ON "ProductExternalReference"("organizationId", "url");
CREATE INDEX "ProductExternalReference_productId_idx"
  ON "ProductExternalReference"("productId");
