-- Per-currency price book, so a customer is charged in a currency their plan
-- actually has a price in — rather than a naira price divided by an exchange
-- rate, which would be a number nobody agreed to.
--
-- Nullable and additive: a plan with no book keeps charging its base price in
-- its base currency, exactly as before.
ALTER TABLE "Plan" ADD COLUMN "prices" JSONB;
