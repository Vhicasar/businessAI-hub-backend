-- CreateTable
CREATE TABLE "ClientError" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "screen" TEXT,
    "vhicasarId" TEXT,
    "organizationId" TEXT,
    "endpoint" TEXT,
    "correlationId" TEXT,
    "device" JSONB,
    "appFlavor" TEXT,
    "extra" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientError_kind_occurredAt_idx" ON "ClientError"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "ClientError_vhicasarId_idx" ON "ClientError"("vhicasarId");

-- CreateIndex
CREATE INDEX "ClientError_organizationId_occurredAt_idx" ON "ClientError"("organizationId", "occurredAt");
