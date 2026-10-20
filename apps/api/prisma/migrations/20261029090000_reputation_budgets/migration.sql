-- REP-1 (#204, FR-CRMS-23): sender-reputation budgets and repetition detection. The guardrail audit gains the
-- reputation kinds, a `deferred` outcome and two paths; a bell notification for reputation alerts; the
-- workspace's thresholds; and a body simhash + normalised subject on outbound mail (sent from the CRM and seen
-- through sync).

-- AlterEnum
ALTER TYPE "guardrail_kind" ADD VALUE 'send_budget';
ALTER TYPE "guardrail_kind" ADD VALUE 'volume_anomaly';
ALTER TYPE "guardrail_kind" ADD VALUE 'bulk_pattern';
ALTER TYPE "guardrail_kind" ADD VALUE 'subject_repeat';
ALTER TYPE "guardrail_kind" ADD VALUE 'negative_reply';
ALTER TYPE "guardrail_kind" ADD VALUE 'primary_domain';
ALTER TYPE "guardrail_outcome" ADD VALUE 'deferred';
ALTER TYPE "guardrail_path" ADD VALUE 'sync';
ALTER TYPE "guardrail_path" ADD VALUE 'pool_send';
ALTER TYPE "notification_kind" ADD VALUE 'guardrail_alert';

-- AlterTable
ALTER TABLE "mail_messages" ADD COLUMN "body_simhash" BIGINT,
ADD COLUMN "subject_key" TEXT;

ALTER TABLE "mail_outbound" ADD COLUMN "body_simhash" BIGINT,
ADD COLUMN "subject_key" TEXT;

-- CreateTable
CREATE TABLE "reputation_settings" (
    "workspace_id" UUID NOT NULL,
    "daily_new_recipients" INTEGER NOT NULL DEFAULT 50,
    "hourly_new_recipients" INTEGER NOT NULL DEFAULT 20,
    "pool_hourly_cap" INTEGER NOT NULL DEFAULT 12,
    "near_duplicate_threshold" INTEGER NOT NULL DEFAULT 10,
    "near_duplicate_distance" INTEGER NOT NULL DEFAULT 3,
    "subject_repeat_threshold" INTEGER NOT NULL DEFAULT 10,
    "primary_domain" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reputation_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- The same bounds the API validates (REPUTATION_LIMITS).
ALTER TABLE "reputation_settings" ADD CONSTRAINT "reputation_settings_ranges" CHECK (
    "daily_new_recipients" BETWEEN 1 AND 2000
    AND "hourly_new_recipients" BETWEEN 1 AND 500
    AND "pool_hourly_cap" BETWEEN 1 AND 500
    AND "near_duplicate_threshold" BETWEEN 2 AND 1000
    AND "near_duplicate_distance" BETWEEN 0 AND 16
    AND "subject_repeat_threshold" BETWEEN 2 AND 1000
    AND ("primary_domain" IS NULL OR "primary_domain" = lower("primary_domain"))
);

-- AddForeignKey
ALTER TABLE "reputation_settings" ADD CONSTRAINT "reputation_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: a workspace's thresholds are its own.
ALTER TABLE "reputation_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reputation_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "reputation_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "reputation_settings" TO bylinecrm_app;

-- A stored message stays as it arrived; only REP-1's two derived columns are filled in later.
GRANT UPDATE ("body_simhash", "subject_key") ON "mail_messages" TO bylinecrm_app;
