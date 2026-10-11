-- P3-2: the sending pool (FR-CRMS-6, -13). Per-workspace pool settings, per-mailbox cap override, warm-up
-- start and pause state, the sending domains with their last DNS check, and the bounces pool mailboxes receive.
-- CreateEnum
CREATE TYPE "sending_domain_status" AS ENUM ('unchecked', 'pass', 'fail');

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "pause_reason" JSONB,
ADD COLUMN     "paused_at" TIMESTAMPTZ,
ADD COLUMN     "pool_daily_cap" INTEGER,
ADD COLUMN     "resumed_at" TIMESTAMPTZ,
ADD COLUMN     "resumed_by_member_id" UUID,
ADD COLUMN     "resume_note" TEXT,
ADD COLUMN     "warmup_started_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "sending_pool_settings" (
    "workspace_id" UUID NOT NULL,
    "daily_cap" INTEGER NOT NULL DEFAULT 40,
    "warmup_start_per_day" INTEGER NOT NULL DEFAULT 5,
    "warmup_days" INTEGER NOT NULL DEFAULT 21,
    "jitter_min_seconds" INTEGER NOT NULL DEFAULT 60,
    "jitter_max_seconds" INTEGER NOT NULL DEFAULT 300,
    "bounce_pause_bps" INTEGER NOT NULL DEFAULT 500,
    "complaint_pause_bps" INTEGER NOT NULL DEFAULT 20,
    "rate_min_sample" INTEGER NOT NULL DEFAULT 20,
    "rate_window_days" INTEGER NOT NULL DEFAULT 7,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sending_pool_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "sending_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "dkim_selector" TEXT NOT NULL DEFAULT 'google',
    "status" "sending_domain_status" NOT NULL DEFAULT 'unchecked',
    "last_check" JSONB,
    "checked_at" TIMESTAMPTZ,
    "next_check_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_bounces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "permanent" BOOLEAN NOT NULL,
    "status" TEXT,
    "outbound_id" UUID,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_bounces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sending_domains_next_check_at_idx" ON "sending_domains"("next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "sending_domains_workspace_id_domain_key" ON "sending_domains"("workspace_id", "domain");

-- CreateIndex
CREATE INDEX "mail_bounces_mailbox_id_occurred_at_idx" ON "mail_bounces"("mailbox_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_bounces_mailbox_id_message_id_address_key" ON "mail_bounces"("mailbox_id", "message_id", "address");

-- AddForeignKey
ALTER TABLE "sending_pool_settings" ADD CONSTRAINT "sending_pool_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "mail_outbound"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_resumed_by_member_id_fkey" FOREIGN KEY ("resumed_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the columns promise: a sending domain and a bounced address are lower case; a pause says why;
-- the settings stay within the ranges the API validates.
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_domain_lower" CHECK ("domain" = lower("domain"));
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_address_lower" CHECK ("address" = lower("address"));
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_pause_complete"
    CHECK (("paused_at" IS NULL AND "pause_reason" IS NULL) OR ("paused_at" IS NOT NULL AND "pause_reason" IS NOT NULL));
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_pool_daily_cap_range" CHECK ("pool_daily_cap" IS NULL OR "pool_daily_cap" BETWEEN 1 AND 500);
ALTER TABLE "sending_pool_settings" ADD CONSTRAINT "sending_pool_settings_ranges" CHECK (
    "daily_cap" BETWEEN 1 AND 500
    AND "warmup_start_per_day" BETWEEN 1 AND "daily_cap"
    AND "warmup_days" BETWEEN 1 AND 90
    AND "jitter_min_seconds" BETWEEN 0 AND 3600
    AND "jitter_max_seconds" BETWEEN "jitter_min_seconds" AND 3600
    AND "bounce_pause_bps" BETWEEN 1 AND 10000
    AND "complaint_pause_bps" BETWEEN 1 AND 10000
    AND "rate_min_sample" BETWEEN 1 AND 10000
    AND "rate_window_days" BETWEEN 1 AND 90
);

-- Warm-up day 1 for pool mailboxes already connected: when they connected.
UPDATE "mailboxes" SET "warmup_started_at" = COALESCE("connected_at", "created_at") WHERE "purpose" = 'pool';

-- Row-level security in P0-2's shape. Settings and domains are updated in place; bounces are written once.
ALTER TABLE "sending_pool_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sending_pool_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sending_pool_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "sending_pool_settings" TO bylinecrm_app;

ALTER TABLE "sending_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sending_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sending_domains"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "sending_domains" TO bylinecrm_app;

ALTER TABLE "mail_bounces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_bounces" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_bounces"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "mail_bounces" TO bylinecrm_app;
