-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "expiryAlertDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "shelfLifeDays" INTEGER;

