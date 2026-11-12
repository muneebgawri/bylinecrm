-- REP-1: the hourly new-recipient budget's default goes from 20 to 35 (REPUTATION_DEFAULTS). Queued follow-ups
-- no longer count against the budgets, so the hour is for first emails only.
ALTER TABLE "reputation_settings" ALTER COLUMN "hourly_new_recipients" SET DEFAULT 35;

-- A workspace still on the old default follows the new one (one row per workspace; never above its daily budget).
UPDATE "reputation_settings"
SET "hourly_new_recipients" = LEAST(35, "daily_new_recipients")
WHERE "hourly_new_recipients" = 20;
