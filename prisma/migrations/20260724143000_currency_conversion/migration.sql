CREATE TABLE "ExchangeRateSnapshot" (
    "id" TEXT NOT NULL,
    "baseCurrency" CHAR(3) NOT NULL,
    "quoteCurrency" CHAR(3) NOT NULL,
    "rate" DECIMAL(24,12) NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeRateSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BillingRecord"
ADD COLUMN "sourceAmount" DECIMAL(14,2),
ADD COLUMN "sourceCurrency" CHAR(3),
ADD COLUMN "exchangeRate" DECIMAL(24,12),
ADD COLUMN "exchangeRateSnapshotId" TEXT;

CREATE INDEX "ExchangeRateSnapshot_baseCurrency_quoteCurrency_fetchedAt_idx"
ON "ExchangeRateSnapshot"("baseCurrency", "quoteCurrency", "fetchedAt");

ALTER TABLE "BillingRecord" ADD CONSTRAINT "BillingRecord_exchangeRateSnapshotId_fkey"
FOREIGN KEY ("exchangeRateSnapshotId") REFERENCES "ExchangeRateSnapshot"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
