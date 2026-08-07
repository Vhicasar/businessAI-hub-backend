-- Opaque token behind the QR printed on a purchase order document.
-- Nullable so existing orders are unaffected; unique so a scan resolves to
-- exactly one order.
ALTER TABLE "PurchaseOrder" ADD COLUMN "scanToken" TEXT;

CREATE UNIQUE INDEX "PurchaseOrder_scanToken_key" ON "PurchaseOrder"("scanToken");
