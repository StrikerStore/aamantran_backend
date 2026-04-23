-- Add a regular index on templateId so the FK can use it after we drop the unique constraint
ALTER TABLE `TemplateReview` ADD INDEX `TemplateReview_templateId_idx` (`templateId`);

-- Drop the unique constraint on (templateId, userId)
ALTER TABLE `TemplateReview` DROP INDEX `TemplateReview_templateId_userId_key`;

-- Make userId nullable (allow admin-created reviews without a real user)
ALTER TABLE `TemplateReview` MODIFY COLUMN `userId` VARCHAR(191) NULL;

-- Add isHidden flag (admin can hide reviews from public view)
ALTER TABLE `TemplateReview` ADD COLUMN `isHidden` BOOLEAN NOT NULL DEFAULT false;

-- Mark admin-created reviews
ALTER TABLE `TemplateReview` ADD COLUMN `isAdminCreated` BOOLEAN NOT NULL DEFAULT false;
