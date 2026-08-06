-- CreateEnum
CREATE TYPE "RiskDecision" AS ENUM ('ALLOW', 'REVIEW', 'BLOCK');

-- CreateEnum
CREATE TYPE "FraudAlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FraudAlertStatus" AS ENUM ('OPEN', 'REVIEWING', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "TrustSubjectType" AS ENUM ('DEVICE', 'CASHIER', 'MERCHANT', 'CUSTOMER');

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "vhicasarId" TEXT,
    "organizationId" TEXT,
    "deviceId" TEXT,
    "score" INTEGER NOT NULL,
    "decision" "RiskDecision" NOT NULL,
    "reasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FraudAlert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "vhicasarId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "severity" "FraudAlertSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "FraudAlertStatus" NOT NULL DEFAULT 'OPEN',
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "assignedToMembershipId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FraudAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustScore" (
    "id" TEXT NOT NULL,
    "subjectType" "TrustSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 50,
    "lastEventAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskAssessment_subjectType_subjectId_idx" ON "RiskAssessment"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "RiskAssessment_organizationId_createdAt_idx" ON "RiskAssessment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_vhicasarId_createdAt_idx" ON "RiskAssessment"("vhicasarId", "createdAt");

-- CreateIndex
CREATE INDEX "FraudAlert_organizationId_status_createdAt_idx" ON "FraudAlert"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FraudAlert_status_createdAt_idx" ON "FraudAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FraudAlert_vhicasarId_idx" ON "FraudAlert"("vhicasarId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustScore_subjectType_subjectId_key" ON "TrustScore"("subjectType", "subjectId");
