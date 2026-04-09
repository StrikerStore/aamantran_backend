-- Optional second event to upgrade when paying for a paired (full + partial) template swap
ALTER TABLE `TemplateSwapRequest` ADD COLUMN `pairedEventId` VARCHAR(191) NULL;
ALTER TABLE `TemplateSwapRequest` ADD CONSTRAINT `TemplateSwapRequest_pairedEventId_fkey` FOREIGN KEY (`pairedEventId`) REFERENCES `Event`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
