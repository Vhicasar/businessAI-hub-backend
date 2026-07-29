-- Link invoices back to the CRM deal they were generated from.
ALTER TABLE "Invoice" ADD COLUMN "dealId" TEXT;

CREATE INDEX "Invoice_dealId_idx" ON "Invoice"("dealId");

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
