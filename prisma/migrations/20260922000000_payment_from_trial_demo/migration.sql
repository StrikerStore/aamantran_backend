-- Whether an order came from a "try it with your names" demo.
--
-- Payment.trialDemoId links an order to its demo, but the demo row is erased a
-- day after it was made and the link goes NULL with it. Analytics could then no
-- longer tell a demo-driven sale from any other, so the admin could never see
-- whether demos sell. This flag is a fact about the order and carries nothing
-- the visitor typed.
--
-- Safety of this migration on live data:
--   * One additive column with a default of false; nothing is dropped or renamed.
--   * The backfill marks only orders whose demo link still exists — at most a
--     day's worth. Older demo-driven orders cannot be told apart any more and
--     stay false; the admin says demo sales are counted from this deploy.
--   * No amount, status, order id or customer data is touched.
--
-- Deploy this BEFORE the backend code that writes `fromTrialDemo`.

ALTER TABLE `Payment`
  ADD COLUMN `fromTrialDemo` BOOLEAN NOT NULL DEFAULT false;

UPDATE `Payment` SET `fromTrialDemo` = true WHERE `trialDemoId` IS NOT NULL;

CREATE INDEX `Payment_fromTrialDemo_createdAt_idx` ON `Payment`(`fromTrialDemo`, `createdAt`);
