-- AlterTable
ALTER TABLE `couponcode` ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `maxGlobalUses` INTEGER NULL,
    ADD COLUMN `maxUsesPerUser` INTEGER NULL,
    ADD COLUMN `minOrderAmount` INTEGER NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payment` ADD COLUMN `couponCode` VARCHAR(191) NULL,
    ADD COLUMN `customerEmail` VARCHAR(191) NULL,
    ADD COLUMN `discountAmount` INTEGER NULL DEFAULT 0;
