-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "externalEventId" TEXT,
ADD COLUMN     "externalProvider" TEXT,
ADD COLUMN     "externalSyncedAt" TIMESTAMP(3),
ADD COLUMN     "externalUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_organizationId_externalProvider_externalEventId_key" ON "Meeting"("organizationId", "externalProvider", "externalEventId");

