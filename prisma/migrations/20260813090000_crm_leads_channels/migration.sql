-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadStatus" ADD VALUE 'ENGAGED';
ALTER TYPE "LeadStatus" ADD VALUE 'NURTURING';

-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "autoReply" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'GENERAL';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "convertedById" TEXT,
ADD COLUMN     "convertedDealId" TEXT,
ADD COLUMN     "reengagedAt" TIMESTAMP(3),
ADD COLUMN     "reengagementCount" INTEGER NOT NULL DEFAULT 0;

