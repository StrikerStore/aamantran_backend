/*
  Warnings:

  - You are about to drop the column `theme` on the `template` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `Template` DROP COLUMN `theme`,
    ADD COLUMN `languages` VARCHAR(191) NOT NULL DEFAULT 'en',
    ADD COLUMN `thumbnailUrl` VARCHAR(191) NULL;
