-- DPDP compliance: consent capture, guest-data retention timestamps, durable auth audit log

-- AlterTable
ALTER TABLE `User`
    ADD COLUMN `consentAt` DATETIME(3) NULL,
    ADD COLUMN `policyVersion` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Payment`
    ADD COLUMN `consentAt` DATETIME(3) NULL,
    ADD COLUMN `policyVersion` VARCHAR(191) NULL,
    ADD COLUMN `marketingOptIn` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Event`
    ADD COLUMN `guestDataWarningSentAt` DATETIME(3) NULL,
    ADD COLUMN `guestDataDeletedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `AuthAuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `event` VARCHAR(64) NOT NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(160) NULL,
    `userId` VARCHAR(191) NULL,
    `details` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuthAuditLog_createdAt_idx`(`createdAt`),
    INDEX `AuthAuditLog_event_createdAt_idx`(`event`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
