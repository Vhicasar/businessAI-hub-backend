-- Warehouse receiving tasks must never reference a destination that no longer exists.
ALTER TABLE "FinishedGoodsReceiptTask"
  ADD CONSTRAINT "FinishedGoodsReceiptTask_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
