-- CreateEnum
CREATE TYPE "VhicasarIdStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycLevel" AS ENUM ('NONE', 'BASIC', 'VERIFIED');

-- CreateEnum
CREATE TYPE "CustomerLinkStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'UNLINKED');

-- CreateEnum
CREATE TYPE "DeviceTrustLevel" AS ENUM ('UNTRUSTED', 'RECOGNIZED', 'TRUSTED');

-- CreateEnum
CREATE TYPE "DomainEventStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "VhicasarId" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "status" "VhicasarIdStatus" NOT NULL DEFAULT 'ACTIVE',
    "kycLevel" "KycLevel" NOT NULL DEFAULT 'NONE',
    "passwordHash" TEXT,
    "pinHash" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "country" CHAR(2),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "VhicasarId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerLink" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "CustomerLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'SUPER_APP',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "vhicasarId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "publicKey" TEXT,
    "pushToken" TEXT,
    "trustLevel" "DeviceTrustLevel" NOT NULL DEFAULT 'UNTRUSTED',
    "isBiometricEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" TEXT,
    "status" "DomainEventStatus" NOT NULL DEFAULT 'PENDING',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VhicasarId_publicId_key" ON "VhicasarId"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "VhicasarId_phone_key" ON "VhicasarId"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "VhicasarId_email_key" ON "VhicasarId"("email");

-- CreateIndex
CREATE INDEX "VhicasarId_phone_idx" ON "VhicasarId"("phone");

-- CreateIndex
CREATE INDEX "VhicasarId_email_idx" ON "VhicasarId"("email");

-- CreateIndex
CREATE INDEX "VhicasarId_status_idx" ON "VhicasarId"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerLink_customerId_key" ON "CustomerLink"("customerId");

-- CreateIndex
CREATE INDEX "CustomerLink_organizationId_idx" ON "CustomerLink"("organizationId");

-- CreateIndex
CREATE INDEX "CustomerLink_vhicasarId_idx" ON "CustomerLink"("vhicasarId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerLink_vhicasarId_organizationId_key" ON "CustomerLink"("vhicasarId", "organizationId");

-- CreateIndex
CREATE INDEX "Device_vhicasarId_idx" ON "Device"("vhicasarId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_vhicasarId_deviceId_key" ON "Device"("vhicasarId", "deviceId");

-- CreateIndex
CREATE INDEX "DomainEvent_status_occurredAt_idx" ON "DomainEvent"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "DomainEvent_organizationId_name_idx" ON "DomainEvent"("organizationId", "name");

-- CreateIndex
CREATE INDEX "DomainEvent_aggregateType_aggregateId_idx" ON "DomainEvent"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "CustomerLink" ADD CONSTRAINT "CustomerLink_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLink" ADD CONSTRAINT "CustomerLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLink" ADD CONSTRAINT "CustomerLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_vhicasarId_fkey" FOREIGN KEY ("vhicasarId") REFERENCES "VhicasarId"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
