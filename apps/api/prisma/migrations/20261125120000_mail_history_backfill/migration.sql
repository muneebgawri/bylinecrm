-- Mail history backfill: a mailbox's sync reaches back past its first import to a history floor (2023-04-01 for every
-- connected mailbox, once), walking backwards window by window from `backfill_before` to `history_floor`. Columns
-- only: the walk itself runs in the sync's jobs and the operator's CLI, never here. Every new column is null or has a
-- constant default, so adding them rewrites nothing.

-- AlterTable
ALTER TABLE "mailbox_sync_states"
    ADD COLUMN "history_floor" TIMESTAMPTZ,
    ADD COLUMN "backfill_before" TIMESTAMPTZ,
    ADD COLUMN "backfill_status" TEXT,
    ADD COLUMN "backfill_progress" JSONB,
    ADD COLUMN "backfill_bytes" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "backfill_lease_until" TIMESTAMPTZ,
    ADD COLUMN "backfill_completed_at" TIMESTAMPTZ;

ALTER TABLE "mailbox_sync_states"
    ADD CONSTRAINT "mailbox_sync_states_backfill_status_check"
    CHECK ("backfill_status" IS NULL OR "backfill_status" IN ('running', 'done', 'budget_reached'));
