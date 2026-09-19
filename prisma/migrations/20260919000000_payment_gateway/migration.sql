-- A second payment gateway.
--
-- Razorpay settles the international storefront (PayU has no international
-- account), and an admin can point either storefront at either gateway. Payment
-- therefore has to say WHICH gateway took the money, and carry the gateway's
-- two ids under names that are not PayU's.
--
-- Safety of this migration on live data:
--   * Every column is additive; nothing is dropped or renamed.
--   * `gateway` defaults to 'payu', so every existing row is correct the moment
--     the column appears — there is no window where a payment's gateway is
--     unknown.
--   * The backfill copies PayU's own ids into the generic columns. Amounts,
--     statuses, order ids and customer data are untouched.
--   * The old payu* columns stay, and stay authoritative for PayU callbacks:
--     PayU sends `txnid` back and that is what we look up.
--
-- Deploy this BEFORE the backend code that reads `gateway`.

ALTER TABLE `Payment`
  ADD COLUMN `gateway`          VARCHAR(191) NOT NULL DEFAULT 'payu',
  ADD COLUMN `gatewayOrderId`   VARCHAR(191) NULL,
  ADD COLUMN `gatewayPaymentId` VARCHAR(191) NULL;

-- Existing orders were all PayU. Mirror their ids into the generic columns so
-- the admin and the refund path can read one pair of columns for both gateways.
UPDATE `Payment`
   SET `gatewayOrderId`   = `payuTxnId`,
       `gatewayPaymentId` = `payuMihpayid`
 WHERE `payuTxnId` IS NOT NULL
    OR `payuMihpayid` IS NOT NULL;

-- Every gateway callback, IPN and webhook finds its payment by one of these.
-- Both were full table scans before; Razorpay's webhook makes that worth fixing.
CREATE INDEX `Payment_payuTxnId_idx`      ON `Payment`(`payuTxnId`);
CREATE INDEX `Payment_gatewayOrderId_idx` ON `Payment`(`gatewayOrderId`);
CREATE INDEX `Payment_gateway_status_idx` ON `Payment`(`gateway`, `status`);
