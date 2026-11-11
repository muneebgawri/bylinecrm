-- A mailbox's copy of a message carries the message's sent_at, so the reputation checks read a mailbox's mail in a
-- window by index instead of joining every message the mailbox ever held (2026-11-11: after the mail history
-- backfill, 10-20k per mailbox, for every check, while the outbox fell hours behind).
-- Nullable, no default: a catalogue change, nothing rewritten. Existing rows are filled in batches by
-- `cli/backfill-copy-sent-at` (never here: a full-table update in a migration blocked the API before).
ALTER TABLE "mail_message_copies" ADD COLUMN "sent_at" TIMESTAMPTZ;

-- (CONCURRENTLY cannot run inside a migration: the build holds writes to the table for its few seconds.)
CREATE INDEX "mail_message_copies_mailbox_id_direction_sent_at_idx"
    ON "mail_message_copies" ("mailbox_id", "direction", "sent_at");
