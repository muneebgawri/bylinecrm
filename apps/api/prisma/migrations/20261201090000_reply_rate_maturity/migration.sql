-- REP-2 (#362): the reply-rate floor judges only sends at least this many hours old, so a burst is not scored on
-- mail nobody has had time to answer.
ALTER TABLE "reputation_settings" ADD COLUMN "reply_rate_maturity_hours" INTEGER NOT NULL DEFAULT 72;
ALTER TABLE "reputation_settings" ADD CONSTRAINT "reputation_settings_reply_rate_maturity_range" CHECK (
    "reply_rate_maturity_hours" BETWEEN 0 AND 720
);
