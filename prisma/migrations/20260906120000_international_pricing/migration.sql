-- International pricing: a second storefront (aamantranglobal.com) priced in USD.
--
-- Only the INR price is ever maintained by hand. The USD price is DERIVED from it
-- (price / usdInrRate * markupMultiplier, rounded up to the next multiple of 10
-- minus a cent) and never stored on Template, so changing the global rate
-- repositions the whole catalogue with no backfill. USD only reaches disk on
-- Payment, where the figure must be frozen at what was actually charged.
--
-- Additive and idempotent by construction: every ALTER adds, none narrows or
-- drops a populated column, and the only data statements are an INSERT IGNORE and
-- a NULL-guarded UPDATE.

-- ── Template ────────────────────────────────────────────────────────────────
-- NULL multiplier means "use AppSetting.defaultMarkupMultiplier".
ALTER TABLE `Template`
    ADD COLUMN `markupMultiplier` DECIMAL(6, 3) NULL;

-- ── CouponCode ──────────────────────────────────────────────────────────────
-- Existing codes were all written against India pricing, so the default keeps
-- them home-only: an India campaign must not leak abroad and give away the
-- markup it exists for. Opt a code in explicitly with 'INTL' or 'BOTH'.
ALTER TABLE `CouponCode`
    ADD COLUMN `storefront` VARCHAR(191) NOT NULL DEFAULT 'IN';

-- ── Payment ─────────────────────────────────────────────────────────────────
-- `storefront` is deliberately not derived from the existing `currency` column:
-- currency is what the buyer was charged, storefront is which website the order
-- came through and therefore which PayU merchant account settles it.
--
-- `countryCode` is the export evidence that zero-rating GST on international
-- sales rests on. `fxRate`/`markupMultiplier` are snapshots so an old order stays
-- explainable after the global rate moves.
ALTER TABLE `Payment`
    ADD COLUMN `storefront`       VARCHAR(191)  NOT NULL DEFAULT 'IN',
    ADD COLUMN `countryCode`      VARCHAR(2)    NULL,
    ADD COLUMN `fxRate`           DECIMAL(12, 4) NULL,
    ADD COLUMN `markupMultiplier` DECIMAL(6, 3)  NULL,
    ADD COLUMN `gstAmount`        INT           NULL DEFAULT 0;

CREATE INDEX `Payment_storefront_status_idx` ON `Payment`(`storefront`, `status`);

-- ── User ────────────────────────────────────────────────────────────────────
-- Dial code split from the number so the picker can re-render without a parsing
-- library. Every pre-existing account is Indian, so the backfill is unambiguous.
-- `phone` itself is left at its current width on purpose: narrowing a populated
-- column risks a truncation failure on deploy for no real gain.
ALTER TABLE `User`
    ADD COLUMN `phoneCountryCode` VARCHAR(8) NULL;

UPDATE `User` SET `phoneCountryCode` = '+91' WHERE `phoneCountryCode` IS NULL;

-- ── WebsiteSession ──────────────────────────────────────────────────────────
-- Nullable: rows predating the global site have no answer. Reporting treats NULL
-- as 'IN' rather than backfilling, so the distinction between "was India" and
-- "predates the split" is not silently erased.
ALTER TABLE `WebsiteSession`
    ADD COLUMN `storefront` VARCHAR(8) NULL;

CREATE INDEX `WebsiteSession_storefront_firstSeenAt_idx`
    ON `WebsiteSession`(`storefront`, `firstSeenAt`);

-- ── WebsiteDailyStat ────────────────────────────────────────────────────────
-- ORDER MATTERS. The column must exist WITH its default before the old unique on
-- `date` is dropped, or existing rows cannot satisfy the composite key that
-- replaces it. Adding the column first also means every historical row is
-- already stamped 'IN' by the time the new unique is built.
ALTER TABLE `WebsiteDailyStat`
    ADD COLUMN `storefront` VARCHAR(8) NOT NULL DEFAULT 'IN';

DROP INDEX `WebsiteDailyStat_date_key` ON `WebsiteDailyStat`;

CREATE UNIQUE INDEX `WebsiteDailyStat_date_storefront_key`
    ON `WebsiteDailyStat`(`date`, `storefront`);

-- ── AppSetting ──────────────────────────────────────────────────────────────
-- Key/value rather than a column each: these are read together, changed rarely,
-- and the next setting should not need a migration.
CREATE TABLE `AppSetting` (
    `key`       VARCHAR(191) NOT NULL,
    `value`     TEXT         NOT NULL,
    `updatedAt` DATETIME(3)  NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the pricing inputs. Without these the first USD derivation has nothing to
-- work from. INSERT IGNORE so re-running never clobbers a rate an admin has since
-- changed.
INSERT IGNORE INTO `AppSetting` (`key`, `value`, `updatedAt`) VALUES
    ('usdInrRate',              '96', NOW(3)),
    ('defaultMarkupMultiplier', '3',  NOW(3));
