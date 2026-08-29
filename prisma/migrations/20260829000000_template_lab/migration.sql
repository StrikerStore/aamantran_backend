-- Template Lab: external template developers get an isolated sandbox — their own
-- login, their own uploaded templates, and a permanent invite slug — without any
-- admin access and without their experiments reaching the public catalogue.

-- CreateTable
CREATE TABLE `DeveloperAccount` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `handle` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sandboxUserId` VARCHAR(191) NOT NULL,
    `templateLimit` INTEGER NOT NULL DEFAULT 10,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DeveloperAccount_email_key`(`email`),
    UNIQUE INDEX `DeveloperAccount_handle_key`(`handle`),
    UNIQUE INDEX `DeveloperAccount_sandboxUserId_key`(`sandboxUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- Presence of sandboxOwnerId *is* the sandbox flag; NULL means a real catalogue template.
ALTER TABLE `Template`
    ADD COLUMN `sandboxOwnerId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Template_sandboxOwnerId_idx` ON `Template`(`sandboxOwnerId`);

-- AddForeignKey
ALTER TABLE `DeveloperAccount`
    ADD CONSTRAINT `DeveloperAccount_sandboxUserId_fkey`
    FOREIGN KEY (`sandboxUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade: removing a developer removes their sandbox templates with them.
ALTER TABLE `Template`
    ADD CONSTRAINT `Template_sandboxOwnerId_fkey`
    FOREIGN KEY (`sandboxOwnerId`) REFERENCES `DeveloperAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
