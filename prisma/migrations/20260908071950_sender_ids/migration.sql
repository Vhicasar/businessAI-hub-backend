-- CreateEnum
CREATE TYPE "SenderIdStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "SenderId" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "status" "SenderIdStatus" NOT NULL DEFAULT 'DRAFT',
    "useCase" TEXT,
    "providerRef" TEXT,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SenderId_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SenderId_organizationId_status_idx" ON "SenderId"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SenderId_status_submittedAt_idx" ON "SenderId"("status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SenderId_organizationId_value_key" ON "SenderId"("organizationId", "value");

-- AddForeignKey
ALTER TABLE "SenderId" ADD CONSTRAINT "SenderId_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

