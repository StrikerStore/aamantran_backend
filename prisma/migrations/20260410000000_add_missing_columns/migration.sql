-- Payment: onboarding + reminder tracking
ALTER TABLE `Payment` ADD COLUMN `isOnboarded` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `Payment` ADD COLUMN `onboardedAt` DATETIME(3) NULL;
ALTER TABLE `Payment` ADD COLUMN `reminderSentAt` DATETIME(3) NULL;

-- Media: slot key for fieldSchema media slots
ALTER TABLE `Media` ADD COLUMN `slotKey` VARCHAR(191) NULL;

-- Event: lifecycle email tracking
ALTER TABLE `Event` ADD COLUMN `lastMilestoneNotified` INTEGER NULL;
ALTER TABLE `Event` ADD COLUMN `countdownEmailSent` INTEGER NULL;
ALTER TABLE `Event` ADD COLUMN `postEventEmailSent` BOOLEAN NOT NULL DEFAULT false;
