-- CreateTable
CREATE TABLE `WebsiteSession` (
    `id` VARCHAR(64) NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `referrer` VARCHAR(255) NULL,
    `utmSource` VARCHAR(128) NULL,
    `utmMedium` VARCHAR(128) NULL,
    `utmCampaign` VARCHAR(128) NULL,
    `deviceType` VARCHAR(16) NULL,
    `browser` VARCHAR(64) NULL,
    `os` VARCHAR(64) NULL,
    `country` VARCHAR(64) NULL,
    `region` VARCHAR(128) NULL,
    `city` VARCHAR(128) NULL,
    `pageViews` INTEGER NOT NULL DEFAULT 0,

    INDEX `WebsiteSession_firstSeenAt_idx`(`firstSeenAt`),
    INDEX `WebsiteSession_lastSeenAt_idx`(`lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebsiteEvent` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(64) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WebsiteEvent_createdAt_idx`(`createdAt`),
    INDEX `WebsiteEvent_type_createdAt_idx`(`type`, `createdAt`),
    INDEX `WebsiteEvent_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebsiteDailyStat` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `visitors` INTEGER NOT NULL DEFAULT 0,
    `pageViews` INTEGER NOT NULL DEFAULT 0,
    `sources` JSON NULL,
    `devices` JSON NULL,
    `countries` JSON NULL,
    `conversions` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WebsiteDailyStat_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WebsiteEvent` ADD CONSTRAINT `WebsiteEvent_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `WebsiteSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
