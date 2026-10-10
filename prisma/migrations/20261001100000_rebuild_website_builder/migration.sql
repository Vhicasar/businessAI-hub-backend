-- Website Builder v2: multiple sites, atomic published releases, richer page
-- lifecycle/version metadata, and privacy-safe first-party analytics.
ALTER TYPE "SiteStatus" ADD VALUE IF NOT EXISTS 'PUBLISHING';
ALTER TYPE "SiteStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "SiteStatus" ADD VALUE IF NOT EXISTS 'UNPUBLISHED';

DROP INDEX IF EXISTS "Site_organizationId_key";

ALTER TABLE "Site"
  ADD COLUMN IF NOT EXISTS "templateId" TEXT,
  ADD COLUMN IF NOT EXISTS "schemaVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS "navigation" JSONB,
  ADD COLUMN IF NOT EXISTS "settings" JSONB,
  ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "publishedSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "publishError" TEXT,
  ADD COLUMN IF NOT EXISTS "lastEditedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "unpublishedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Site_organizationId_idx" ON "Site"("organizationId");
CREATE INDEX IF NOT EXISTS "Site_organizationId_updatedAt_idx" ON "Site"("organizationId", "updatedAt");

ALTER TABLE "SitePage"
  ADD COLUMN IF NOT EXISTS "isHome" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "showInNav" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DRAFT';

UPDATE "SitePage" SET "isHome" = true WHERE "slug" = '';

ALTER TABLE "SiteVersion"
  ADD COLUMN IF NOT EXISTS "editorUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "isPublished" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "SiteEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "referrerHost" TEXT,
  "sessionHash" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SiteEvent_siteId_createdAt_idx" ON "SiteEvent"("siteId", "createdAt");
CREATE INDEX IF NOT EXISTS "SiteEvent_organizationId_createdAt_idx" ON "SiteEvent"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "SiteEvent_siteId_type_createdAt_idx" ON "SiteEvent"("siteId", "type", "createdAt");
