-- AlterTable (idempotent: adds columns only if they don't already exist)
DROP PROCEDURE IF EXISTS _add_demo_fn_columns;
CREATE PROCEDURE _add_demo_fn_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'templatedemofunction'
      AND COLUMN_NAME  = 'venueMapUrl'
  ) THEN
    ALTER TABLE `templatedemofunction` ADD COLUMN `venueMapUrl` VARCHAR(2048) NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'templatedemofunction'
      AND COLUMN_NAME  = 'dressCode'
  ) THEN
    ALTER TABLE `templatedemofunction` ADD COLUMN `dressCode` VARCHAR(191) NULL;
  END IF;
END;
CALL _add_demo_fn_columns();
DROP PROCEDURE IF EXISTS _add_demo_fn_columns;
