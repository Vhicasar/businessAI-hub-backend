-- Durable record of every transactional-email delivery attempt so failures are
-- troubleshootable after the fact and a background sweep can re-send
-- verification emails that never got through. Global (no organizationId FK; the
-- column is nullable because registration emails predate an org membership).
CREATE TABLE "EmailDeliveryLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT,
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailDeliveryLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailDeliveryLog_recipient_type_createdAt_idx" ON "EmailDeliveryLog"("recipient", "type", "createdAt");
CREATE INDEX "EmailDeliveryLog_userId_type_createdAt_idx" ON "EmailDeliveryLog"("userId", "type", "createdAt");
CREATE INDEX "EmailDeliveryLog_status_type_createdAt_idx" ON "EmailDeliveryLog"("status", "type", "createdAt");
