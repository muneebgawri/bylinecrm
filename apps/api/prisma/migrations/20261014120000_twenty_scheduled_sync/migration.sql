-- #185 (P4-4f): scheduled Twenty sync. A workspace setting runs the importer's `changes` mode on its own
-- (off, every 15 minutes, hourly or daily); the settings row remembers how it has been going and whether
-- an admin stopped it for good (the cutover). A run says whether the schedule started it.
-- AlterTable
ALTER TABLE "twenty_import_settings" ADD COLUMN     "cutover_at" TIMESTAMPTZ,
ADD COLUMN     "sync_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sync_interval" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "sync_last_error" TEXT;

-- AlterTable
ALTER TABLE "twenty_import_runs" ADD COLUMN     "scheduled" BOOLEAN NOT NULL DEFAULT false;

-- What the schema cannot say: the intervals a schedule may have, and that a failure count is never negative.
ALTER TABLE "twenty_import_settings" ADD CONSTRAINT "twenty_import_settings_sync"
    CHECK ("sync_interval" IN ('off', '15m', 'hourly', 'daily') AND "sync_failures" >= 0);
