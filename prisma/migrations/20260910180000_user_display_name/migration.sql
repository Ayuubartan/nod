-- Display name, only ever as supplied by a social sign-in provider (docs/07 section 3).
-- Nullable with no backfill: every existing row predates social sign-in and has none.
ALTER TABLE "User" ADD COLUMN     "name" TEXT;
