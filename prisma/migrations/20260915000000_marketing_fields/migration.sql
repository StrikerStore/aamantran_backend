-- Storefront marketing metadata.
--
-- shortDescription: the one-line sentence shown on gallery cards and above the
-- fold on the product page. Today every card falls back to a generic sentence
-- built from the community, so all cards for one community read identically.
--
-- highlights: comma-separated capability chips from a fixed vocabulary
-- (see src/lib/constants.js TEMPLATE_HIGHLIGHTS), stored the same way as
-- bestFor and languages on this table.
--
-- Both are NULL-able and purely additive: the storefront falls back to
-- aboutText when they are unset, so existing templates keep working untouched.
ALTER TABLE `Template`
    ADD COLUMN `shortDescription` VARCHAR(300) NULL,
    ADD COLUMN `highlights` VARCHAR(500) NULL;
