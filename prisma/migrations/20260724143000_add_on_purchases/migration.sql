CREATE TABLE "AddOnPurchase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "addOnId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "billingType" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "entitlements" JSONB NOT NULL,
    "provider" TEXT,
    "providerRef" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AddOnPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AddOnPurchase_providerRef_key" ON "AddOnPurchase"("providerRef");
CREATE INDEX "AddOnPurchase_organizationId_expiresAt_idx" ON "AddOnPurchase"("organizationId", "expiresAt");
CREATE INDEX "AddOnPurchase_organizationId_addOnId_idx" ON "AddOnPurchase"("organizationId", "addOnId");
ALTER TABLE "AddOnPurchase" ADD CONSTRAINT "AddOnPurchase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
