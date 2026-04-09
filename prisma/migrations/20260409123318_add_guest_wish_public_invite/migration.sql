-- AlterTable
ALTER TABLE `function` ADD COLUMN `venueId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `template` ADD COLUMN `fieldSchema` JSON NULL;

-- AlterTable
ALTER TABLE `templatedemodata` ADD COLUMN `customFields` JSON NULL,
    ADD COLUMN `people` JSON NULL;

-- CreateTable
CREATE TABLE `EventPerson` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `photoUrl` VARCHAR(191) NULL,
    `extraData` JSON NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `EventPerson_eventId_idx`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Venue` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NULL,
    `lat` DECIMAL(10, 8) NULL,
    `lng` DECIMAL(11, 8) NULL,
    `mapUrl` VARCHAR(2048) NULL,
    `city` VARCHAR(191) NULL,
    `state` VARCHAR(191) NULL,

    INDEX `Venue_eventId_idx`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EventCustomField` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `fieldKey` VARCHAR(191) NOT NULL,
    `fieldValue` TEXT NOT NULL,
    `fieldType` VARCHAR(191) NOT NULL DEFAULT 'text',

    INDEX `EventCustomField_eventId_idx`(`eventId`),
    UNIQUE INDEX `EventCustomField_eventId_fieldKey_key`(`eventId`, `fieldKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EventRenderCache` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `htmlDesktop` LONGTEXT NOT NULL,
    `htmlMobile` LONGTEXT NOT NULL,
    `dataJson` JSON NOT NULL,
    `builtAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EventRenderCache_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GuestWish` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `guestName` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `isApproved` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GuestWish_eventId_idx`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EventPerson` ADD CONSTRAINT `EventPerson_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Venue` ADD CONSTRAINT `Venue_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventCustomField` ADD CONSTRAINT `EventCustomField_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventRenderCache` ADD CONSTRAINT `EventRenderCache_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Function` ADD CONSTRAINT `Function_venueId_fkey` FOREIGN KEY (`venueId`) REFERENCES `Venue`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GuestWish` ADD CONSTRAINT `GuestWish_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
