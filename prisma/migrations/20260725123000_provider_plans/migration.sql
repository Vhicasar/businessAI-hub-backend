-- Maps a local plan (× interval × currency) to the recurring plan created in a
-- payment gateway, so subscription checkouts charge through a real gateway plan
-- and appear as Subscriptions in the provider dashboard (fixing subscriptions
-- previously showing as one-off payments). Global (no organizationId).
CREATE TABLE "ProviderPlan" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "interval" "PlanInterval" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "providerPlanCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderPlan_provider_planId_interval_currency_key" ON "ProviderPlan"("provider", "planId", "interval", "currency");
CREATE INDEX "ProviderPlan_provider_providerPlanCode_idx" ON "ProviderPlan"("provider", "providerPlanCode");
