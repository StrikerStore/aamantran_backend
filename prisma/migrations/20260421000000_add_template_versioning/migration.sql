-- CreateTable
CREATE TABLE `TemplateVersion` (
  `id`               VARCHAR(191) NOT NULL,
  `templateId`       VARCHAR(191) NOT NULL,
  `versionNumber`    INT          NOT NULL,
  `folderPath`       VARCHAR(191) NOT NULL,
  `desktopEntryFile` VARCHAR(191) NULL,
  `mobileEntryFile`  VARCHAR(191) NULL,
  `fieldSchema`      JSON         NULL,
  `createdAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `TemplateVersion_templateId_versionNumber_key` (`templateId`, `versionNumber`),
  INDEX        `TemplateVersion_templateId_idx`               (`templateId`),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: Template
ALTER TABLE `Template`
  ADD COLUMN `currentVersionId` VARCHAR(191) NULL;

-- AlterTable: Event
ALTER TABLE `Event`
  ADD COLUMN `templateVersionId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `TemplateVersion`
  ADD CONSTRAINT `TemplateVersion_templateId_fkey`
  FOREIGN KEY (`templateId`) REFERENCES `Template`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Template`
  ADD CONSTRAINT `Template_currentVersionId_fkey`
  FOREIGN KEY (`currentVersionId`) REFERENCES `TemplateVersion`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Event`
  ADD CONSTRAINT `Event_templateVersionId_fkey`
  FOREIGN KEY (`templateVersionId`) REFERENCES `TemplateVersion`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
