-- AlterTable: Payment — add orderId as nullable unique human-readable reference field
ALTER TABLE `Payment` ADD COLUMN `orderId` VARCHAR(191) NULL;

-- CreateIndex: unique constraint so no two payments share the same reference ID
CREATE UNIQUE INDEX `Payment_orderId_key` ON `Payment`(`orderId`);
