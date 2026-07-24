-- Employee profile photo. Nullable; references a File by id (no FK — File is
-- soft-deleted and cross-referenced by many entities the same loose way).
ALTER TABLE "Employee" ADD COLUMN "avatarFileId" TEXT;
