-- REP-2 (#205, FR-CRMS-24): the recipient quality gate, the reply-rate floor and the spam-rate kill switch —
-- their guardrail kinds and their thresholds. A paused mailbox reuses P3-2's `paused_at` / `pause_reason`
-- (now for personal mailboxes too: new recipients held, replies still sent).

-- AlterEnum
ALTER TYPE "guardrail_kind" ADD VALUE 'recipient_quality';
ALTER TYPE "guardrail_kind" ADD VALUE 'reply_rate';
ALTER TYPE "guardrail_kind" ADD VALUE 'spam_rate';

-- AlterTable
ALTER TABLE "reputation_settings" ADD COLUMN "reply_rate_floor_bps" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN "reply_rate_min_sends" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN "reply_rate_window_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN "spam_pause_bps" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "spam_warn_bps" INTEGER NOT NULL DEFAULT 10;

-- The same bounds the API validates (REPUTATION_LIMITS); the warn line is under the kill switch.
ALTER TABLE "reputation_settings" ADD CONSTRAINT "reputation_settings_rep2_ranges" CHECK (
    "reply_rate_floor_bps" BETWEEN 0 AND 10000
    AND "reply_rate_min_sends" BETWEEN 1 AND 10000
    AND "reply_rate_window_days" BETWEEN 1 AND 90
    AND "spam_pause_bps" BETWEEN 1 AND 10000
    AND "spam_warn_bps" BETWEEN 1 AND 10000
    AND "spam_warn_bps" <= "spam_pause_bps"
);
