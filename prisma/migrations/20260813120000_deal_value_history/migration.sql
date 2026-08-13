-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "originalValue" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "DealValueChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "previousValue" DECIMAL(14,2) NOT NULL,
    "newValue" DECIMAL(14,2) NOT NULL,
    "difference" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealValueChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealValueChange_dealId_createdAt_idx" ON "DealValueChange"("dealId", "createdAt");

-- AddForeignKey
ALTER TABLE "DealValueChange" ADD CONSTRAINT "DealValueChange_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing deals have never had their value changed, so what they are worth now
-- is also what they opened at. Without this, every deal created before today
-- would show a blank original value.
UPDATE "Deal" SET "originalValue" = "value" WHERE "originalValue" IS NULL;
