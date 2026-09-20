-- When a refund was issued.
--
-- The refund path wrote only `status = 'refunded'`, with no date and no amount.
-- That is enough for the admin table but not for a GST return: a refund issued
-- in August against a July order belongs in August's return, and with no date
-- the two are indistinguishable.
--
-- Safety of this migration on live data:
--   * Every column is additive and NULL-able; nothing is dropped or renamed.
--   * There is no backfill, on purpose. Refunds recorded before this migration
--     genuinely have no date, and inventing one — the order date, the deploy
--     date — would put money in a tax period it did not belong to. NULL is the
--     honest value, and the GST report marks those rows rather than guessing.
--   * No amount, status, order id or customer data is touched.
--
-- Deploy this BEFORE the backend code that writes `refundedAt`.

ALTER TABLE `Payment`
  ADD COLUMN `refundedAt`      DATETIME(3)  NULL,
  ADD COLUMN `refundAmount`    INT          NULL,
  ADD COLUMN `refundReference` VARCHAR(191) NULL;
