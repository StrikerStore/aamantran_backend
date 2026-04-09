-- Paired admin-generated invites: full (all functions) + subset (selected functions)
ALTER TABLE `Event` ADD COLUMN `inviteScope` VARCHAR(191) NULL;
ALTER TABLE `Event` ADD COLUMN `invitePairId` VARCHAR(191) NULL;
CREATE INDEX `Event_invitePairId_idx` ON `Event`(`invitePairId`);
