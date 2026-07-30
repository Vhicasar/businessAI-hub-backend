UPDATE "DomainDeploymentConfig"
SET
  "baseDomain" = 'businesshub.com',
  "cnameTarget" = 'businesshub.com',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "id" = 'domain_hostinger_default'
  AND "baseDomain" = 'businesshub.app';
