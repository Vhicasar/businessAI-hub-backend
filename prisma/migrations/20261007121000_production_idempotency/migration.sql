ALTER TABLE "ProductionOutput" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionOutput_organizationId_idempotencyKey_key"
ON "ProductionOutput"("organizationId", "idempotencyKey");

CREATE TABLE IF NOT EXISTS "ProductionOperation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "productionOrderId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductionOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionOperation_organizationId_kind_idempotencyKey_key"
ON "ProductionOperation"("organizationId", "kind", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "ProductionOperation_productionOrderId_createdAt_idx"
ON "ProductionOperation"("productionOrderId", "createdAt");
