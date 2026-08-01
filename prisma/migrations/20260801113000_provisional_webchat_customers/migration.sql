ALTER TABLE "Customer" ADD COLUMN "isProvisional" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Customer_organizationId_isProvisional_idx" ON "Customer"("organizationId", "isProvisional");

-- Existing anonymous website-chat identities were previously exposed as CRM
-- customers. Hide only the known placeholder records; named/contacted visitors
-- remain normal customers.
UPDATE "Customer" AS c
SET "isProvisional" = true
FROM "CustomerIdentity" AS i
WHERE i."customerId" = c.id
  AND i."channelType" = 'WEB_CHAT'
  AND c.email IS NULL
  AND c.phone IS NULL
  AND lower(coalesce(c."displayName", c."firstName")) IN ('website visitor', 'visitor', 'guest', 'anonymous');
