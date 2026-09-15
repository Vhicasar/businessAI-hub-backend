ALTER TABLE "Subscription" ADD COLUMN "pastDueAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "subscriptionDraftAt" TIMESTAMP(3),
ADD COLUMN "subscriptionDraftReason" TEXT;
ALTER TABLE "Customer" ADD COLUMN "subscriptionDraftPreviousBlocked" BOOLEAN;
ALTER TABLE "Product" ADD COLUMN "subscriptionDraftAt" TIMESTAMP(3),
ADD COLUMN "subscriptionDraftReason" TEXT;
ALTER TABLE "Product" ADD COLUMN "subscriptionDraftPreviousStatus" "ProductStatus";
CREATE INDEX "Customer_organizationId_subscriptionDraftAt_idx" ON "Customer"("organizationId", "subscriptionDraftAt");
CREATE INDEX "Product_organizationId_subscriptionDraftAt_idx" ON "Product"("organizationId", "subscriptionDraftAt");
