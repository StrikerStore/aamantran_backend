-- Master template-testing account: one permanent user that loads a single template
-- at a time (drafts included) with no payment, excluded from every admin analytic.

-- AlterTable
ALTER TABLE `User`
    ADD COLUMN `isTestAccount` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Event`
    ADD COLUMN `isTestEvent` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `User_isTestAccount_idx` ON `User`(`isTestAccount`);

-- CreateIndex
CREATE INDEX `Event_isTestEvent_idx` ON `Event`(`isTestEvent`);
