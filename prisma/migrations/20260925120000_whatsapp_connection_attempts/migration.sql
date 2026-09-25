CREATE TABLE "WhatsAppConnectionAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "connectionMode" TEXT NOT NULL,
    "wabaId" TEXT,
    "phoneNumberId" TEXT,
    "metaBusinessId" TEXT,
    "oauthCodeReceivedAt" TIMESTAMP(3),
    "sessionInfoReceivedAt" TIMESTAMP(3),
    "channelAccountId" TEXT,
    "errorCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsAppConnectionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WhatsAppConnectionAttempt_organizationId_status_idx"
ON "WhatsAppConnectionAttempt"("organizationId", "status");

CREATE INDEX "WhatsAppConnectionAttempt_expiresAt_idx"
ON "WhatsAppConnectionAttempt"("expiresAt");
