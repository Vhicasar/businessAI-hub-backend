-- CreateTable
CREATE TABLE "SiteVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteVersion_siteId_idx" ON "SiteVersion"("siteId");

-- CreateIndex
CREATE INDEX "SiteVersion_organizationId_idx" ON "SiteVersion"("organizationId");
