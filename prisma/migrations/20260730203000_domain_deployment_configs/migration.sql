CREATE TABLE "DomainDeploymentConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'HOSTINGER',
    "baseDomain" TEXT NOT NULL,
    "cnameTarget" TEXT NOT NULL,
    "verificationTarget" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DomainDeploymentConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DomainDeploymentConfig_baseDomain_key" ON "DomainDeploymentConfig"("baseDomain");

INSERT INTO "DomainDeploymentConfig"
  ("id", "name", "provider", "baseDomain", "cnameTarget", "isActive", "isDefault", "updatedAt")
VALUES
  ('domain_hostinger_default', 'Hostinger default', 'HOSTINGER', 'businesshub.app', 'businesshub.app', true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("baseDomain") DO NOTHING;
