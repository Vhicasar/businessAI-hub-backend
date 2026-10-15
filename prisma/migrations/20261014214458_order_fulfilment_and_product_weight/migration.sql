-- Fulfilment choice, per-order contact details and delivery pricing inputs.
--
-- Every column is nullable and every existing row keeps its current meaning:
-- an order raised before this migration simply has no fulfilment method
-- recorded, which is the truth about it. Nothing is backfilled, so no historic
-- order acquires a delivery fee it was never charged.

-- CreateEnum
CREATE TYPE "FulfillmentMethod" AS ENUM ('PICKUP', 'DELIVERY');

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "fulfillmentMethod" "FulfillmentMethod",
  ADD COLUMN "contactName"       TEXT,
  ADD COLUMN "contactPhone"      TEXT,
  ADD COLUMN "contactEmail"      TEXT,
  ADD COLUMN "deliverySnapshot"  JSONB,
  ADD COLUMN "deliveryQuote"     JSONB;

-- AlterTable
-- Product-level fallback weight. Null means unknown, which delivery pricing
-- treats as "ask", never as zero.
ALTER TABLE "Product" ADD COLUMN "weightGrams" INTEGER;
