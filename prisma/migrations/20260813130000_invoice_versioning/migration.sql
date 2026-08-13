-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "replacedByInvoiceId" TEXT,
ADD COLUMN     "replacesInvoiceId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_replacedByInvoiceId_key" ON "Invoice"("replacedByInvoiceId");

