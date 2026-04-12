-- Idempotent migration: rename Razorpay columns to PayU columns
-- Uses stored procedure + information_schema checks so it is safe to re-run.

DROP PROCEDURE IF EXISTS _migrate_to_payu;
CREATE PROCEDURE _migrate_to_payu()
BEGIN
  -- Payment: razorpayOrderId → payuTxnId
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Payment' AND COLUMN_NAME = 'razorpayOrderId'
  ) THEN
    ALTER TABLE `Payment` RENAME COLUMN `razorpayOrderId` TO `payuTxnId`;
  END IF;

  -- Payment: razorpayPaymentId → payuMihpayid
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Payment' AND COLUMN_NAME = 'razorpayPaymentId'
  ) THEN
    ALTER TABLE `Payment` RENAME COLUMN `razorpayPaymentId` TO `payuMihpayid`;
  END IF;

  -- TemplateSwapRequest: razorpayLinkId → payuLinkId
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TemplateSwapRequest' AND COLUMN_NAME = 'razorpayLinkId'
  ) THEN
    ALTER TABLE `TemplateSwapRequest` RENAME COLUMN `razorpayLinkId` TO `payuLinkId`;
  END IF;

  -- TemplateSwapRequest: razorpayLinkUrl → payuLinkUrl
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TemplateSwapRequest' AND COLUMN_NAME = 'razorpayLinkUrl'
  ) THEN
    ALTER TABLE `TemplateSwapRequest` RENAME COLUMN `razorpayLinkUrl` TO `payuLinkUrl`;
  END IF;
END;

CALL _migrate_to_payu();
DROP PROCEDURE IF EXISTS _migrate_to_payu;
