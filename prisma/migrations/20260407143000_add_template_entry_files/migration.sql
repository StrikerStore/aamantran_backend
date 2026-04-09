-- Persist detected desktop/mobile entry files for template bundles
ALTER TABLE `Template`
  ADD COLUMN `desktopEntryFile` VARCHAR(191) NULL,
  ADD COLUMN `mobileEntryFile` VARCHAR(191) NULL;
