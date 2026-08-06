-- AlterTable
ALTER TABLE "WalletEntry" ADD COLUMN     "bucket" "WalletBucket" NOT NULL DEFAULT 'AVAILABLE';
