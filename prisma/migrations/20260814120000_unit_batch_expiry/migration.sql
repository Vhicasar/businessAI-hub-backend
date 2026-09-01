-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderReceiptLine" ADD COLUMN     "batchNumber" TEXT,
ADD COLUMN     "expiryDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "batchNumber" TEXT,
ADD COLUMN     "expiryDate" TIMESTAMP(3);

