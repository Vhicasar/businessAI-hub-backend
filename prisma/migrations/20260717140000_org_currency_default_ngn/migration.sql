-- Signup now resolves an organisation's currency from the owner's location
-- (shared/currency.ts). This default is only the last resort, and naira is the
-- honest one: the subscription plans are priced in NGN, so an org that reached
-- the default was being told "USD" while being billed in naira.
--
-- Deliberately NOT backfilling existing rows: an organisation's currency is a
-- statement about the money already recorded against it, and rewriting the
-- label without touching the amounts would silently restate every price.
ALTER TABLE "Organization" ALTER COLUMN "currency" SET DEFAULT 'NGN';
