-- CreateEnum
CREATE TYPE "SmsMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SmsRouteType" AS ENUM ('TRANSACTIONAL', 'PROMOTIONAL');

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT,
    "customerId" TEXT,
    "senderIdId" TEXT,
    "senderValue" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "route" "SmsRouteType" NOT NULL DEFAULT 'TRANSACTIONAL',
    "status" "SmsMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "segments" INTEGER NOT NULL DEFAULT 1,
    "encoding" TEXT NOT NULL DEFAULT 'GSM_7BIT',
    "cost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "providerCost" DECIMAL(14,4),
    "providerMessageId" TEXT,
    "reference" TEXT NOT NULL,
    "failureReason" TEXT,
    "eventType" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsSuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsMessage_organizationId_queuedAt_idx" ON "SmsMessage"("organizationId", "queuedAt");

-- CreateIndex
CREATE INDEX "SmsMessage_organizationId_status_idx" ON "SmsMessage"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SmsMessage_campaignId_idx" ON "SmsMessage"("campaignId");

-- CreateIndex
CREATE INDEX "SmsMessage_providerMessageId_idx" ON "SmsMessage"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "SmsMessage_organizationId_reference_key" ON "SmsMessage"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "SmsSuppression_organizationId_createdAt_idx" ON "SmsSuppression"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SmsSuppression_organizationId_phone_key" ON "SmsSuppression"("organizationId", "phone");

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsSuppression" ADD CONSTRAINT "SmsSuppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

