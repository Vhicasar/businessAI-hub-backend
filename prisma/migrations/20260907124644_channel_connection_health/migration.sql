-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('CONNECTED', 'CONNECTING', 'DISCONNECTED', 'EXPIRED', 'ERROR');

-- AlterTable
ALTER TABLE "ChannelAccount" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'CONNECTED';

