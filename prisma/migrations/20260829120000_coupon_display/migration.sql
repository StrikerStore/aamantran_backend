-- Coupons can now be advertised on the public checkout page.
--
-- Separate from isActive on purpose: isActive decides whether the code works
-- when typed, isDisplayed whether we also show it to everyone. Defaults to
-- false so no existing coupon -- partner codes, one-off goodwill discounts,
-- test codes -- becomes public on deploy.
ALTER TABLE `CouponCode`
    ADD COLUMN `isDisplayed` BOOLEAN NOT NULL DEFAULT false;
