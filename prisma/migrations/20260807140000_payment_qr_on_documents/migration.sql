-- Print a scannable pay code on invoices, receipts and rent demands.
-- Defaults to true: an existing business gets the feature without having to
-- find a setting, and can turn it off if it bills on account.
ALTER TABLE "Organization" ADD COLUMN "paymentQrOnDocuments" BOOLEAN NOT NULL DEFAULT true;
