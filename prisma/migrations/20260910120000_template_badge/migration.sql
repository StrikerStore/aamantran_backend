-- Optional merchandising tag shown in the corner of a template card.
--
-- Nullable with no default: most templates carry no tag, and NULL is the honest
-- representation of "none" rather than a sentinel string every read has to know
-- about. Stored as the lowercase key ('new', 'trending', ...), never the display
-- label, so the wording on the storefront can change without a migration.
--
-- Additive and safe to re-run behind `migrate deploy`: it only adds a column.
ALTER TABLE `Template`
    ADD COLUMN `badge` VARCHAR(20) NULL;
