-- The couple's two name slots become person1 / person2 (were groom / bride).
--
-- Couples always saw these as "Person 1" / "Person 2"; which one held the bride
-- was never recorded, so the old column names were wrong for half the events.
--
-- Safety of this migration on live data:
--   * Additive: two new nullable/defaulted columns per table. Nothing is dropped
--     or renamed, so the previous backend keeps working if it is rolled back.
--   * The old columns get a '' default on TemplateDemoData so creates no longer
--     need them. Their values are untouched.
--   * Values are copied by scripts/backfill-person-slots.js (run by db:deploy),
--     which needs each template's slot order and so cannot be plain SQL.
--
-- Deploy this BEFORE the backend code that reads person1Name / person2Name.
-- The old columns are dropped in a later release.

ALTER TABLE `Event`
  ADD COLUMN `person1Name` VARCHAR(191) NULL,
  ADD COLUMN `person2Name` VARCHAR(191) NULL;

ALTER TABLE `TemplateDemoData`
  ADD COLUMN `person1Name` VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN `person2Name` VARCHAR(191) NOT NULL DEFAULT '',
  MODIFY `brideName` VARCHAR(191) NOT NULL DEFAULT '',
  MODIFY `groomName` VARCHAR(191) NOT NULL DEFAULT '';
