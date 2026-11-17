-- Whether a template's price already includes GST.
--
-- Every existing template becomes GST-inclusive: its listed price is now the
-- total an India buyer pays (a ₹2,999 invite costs ₹2,999 at checkout, GST
-- included) instead of the price before GST is added. The DEFAULT is what
-- converts them; no separate UPDATE is needed. New templates default to
-- inclusive too, and the admin can mark any template exclusive.
--
-- Payments already made are not touched: Payment.amount and Payment.gstAmount
-- hold what was actually charged.

-- AlterTable
ALTER TABLE `Template`
    ADD COLUMN `gstInclusive` BOOLEAN NOT NULL DEFAULT true;
