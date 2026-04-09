-- AlterTable
ALTER TABLE `Event` ADD COLUMN `instagramUrl` VARCHAR(2048) NULL,
    ADD COLUMN `socialYoutubeUrl` VARCHAR(2048) NULL,
    ADD COLUMN `websiteUrl` VARCHAR(2048) NULL,
    ADD COLUMN `rsvpEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `guestNotesEnabled` BOOLEAN NOT NULL DEFAULT true;
