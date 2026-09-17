-- "Try it with your names": a personal, watermarked demo of a real template,
-- created with no account and no payment.
--
-- The row holds the only personal data involved — the names, date, venue and
-- ceremonies a visitor typed — so it is built to be short-lived:
--   linkExpiresAt  the shareable link stops working (minutes)
--   dataExpiresAt  the payload is erased by the scheduled purge (hours)
-- The visitor's IP is never stored; ipHash is a salted SHA-256 used only to cap
-- how many demos one address can create, and it goes when the row does.
--
-- Additive and isolated: nothing existing reads this table, so deploying the
-- migration ahead of the code that uses it changes no behaviour.
CREATE TABLE `TrialDemo` (
    `id`            VARCHAR(191) NOT NULL,
    `token`         VARCHAR(32)  NOT NULL,
    `templateId`    VARCHAR(191) NOT NULL,
    `payload`       JSON         NOT NULL,
    `ipHash`        VARCHAR(64)  NULL,
    `linkExpiresAt` DATETIME(3)  NOT NULL,
    `dataExpiresAt` DATETIME(3)  NOT NULL,
    `viewCount`     INTEGER      NOT NULL DEFAULT 0,
    `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TrialDemo_token_key`(`token`),
    -- The purge sweeps by expiry; the cap counts recent rows for one address.
    INDEX `TrialDemo_dataExpiresAt_idx`(`dataExpiresAt`),
    INDEX `TrialDemo_ipHash_createdAt_idx`(`ipHash`, `createdAt`),
    INDEX `TrialDemo_templateId_idx`(`templateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Which demo a purchase came from, so the builder can be prefilled with what the
-- buyer already typed. NULL for every existing and most future payments.
ALTER TABLE `Payment`
    ADD COLUMN `trialDemoId` VARCHAR(191) NULL;

CREATE INDEX `Payment_trialDemoId_idx` ON `Payment`(`trialDemoId`);

ALTER TABLE `TrialDemo`
    ADD CONSTRAINT `TrialDemo_templateId_fkey`
    FOREIGN KEY (`templateId`) REFERENCES `Template`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: the demo is erased within a day, and deleting it must
-- never take a payment record with it.
ALTER TABLE `Payment`
    ADD CONSTRAINT `Payment_trialDemoId_fkey`
    FOREIGN KEY (`trialDemoId`) REFERENCES `TrialDemo`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
