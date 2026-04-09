-- Add separate thumbnail URLs for desktop and mobile previews
ALTER TABLE `Template`
  ADD COLUMN `desktopThumbnailUrl` VARCHAR(191) NULL,
  ADD COLUMN `mobileThumbnailUrl` VARCHAR(191) NULL;

-- Backfill desktop thumbnail from legacy thumbnailUrl
UPDATE `Template`
SET `desktopThumbnailUrl` = `thumbnailUrl`
WHERE `thumbnailUrl` IS NOT NULL AND `desktopThumbnailUrl` IS NULL;
