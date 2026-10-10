-- Raw materials already use Product.manufacturingType. This index makes the
-- catalog/inventory split and every sales-safe lookup tenant efficient.
CREATE INDEX IF NOT EXISTS "Product_organizationId_manufacturingType_status_idx"
ON "Product"("organizationId", "manufacturingType", "status");

-- Existing rows remain unclassified/finished catalog products. We deliberately
-- do not infer raw materials from names or categories.
