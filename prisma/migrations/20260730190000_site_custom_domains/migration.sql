ALTER TABLE "Site"
ADD COLUMN "customDomain" TEXT,
ADD COLUMN "domainVerificationToken" TEXT,
ADD COLUMN "domainVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Site_customDomain_key" ON "Site"("customDomain");
