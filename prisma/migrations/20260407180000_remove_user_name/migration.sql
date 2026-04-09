-- Remove legacy `name` column; accounts use `username` (see User in schema.prisma).
-- Plain DROP COLUMN for MySQL & MariaDB versions that do not support DROP COLUMN IF EXISTS (8.0.29+).
ALTER TABLE `User` DROP COLUMN `name`;
