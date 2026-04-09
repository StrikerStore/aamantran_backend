-- Drop unique on email: same email may appear on multiple User rows (one per purchase / username).
DROP INDEX `User_email_key` ON `User`;

CREATE INDEX `User_email_idx` ON `User`(`email`);
