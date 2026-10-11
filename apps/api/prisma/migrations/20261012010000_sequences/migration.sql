-- P3-3 Sequences (FR-CRMS-5, -10, -11, -12). docs/design-notes/P3-3.md.

CREATE TYPE "region_code" AS ENUM ('eu', 'uk', 'ca', 'us', 'other', 'unknown');
CREATE TYPE "exclusion_reason" AS ENUM ('customer', 'account_managed');
CREATE TYPE "sequence_status" AS ENUM ('draft', 'active', 'paused', 'archived');
CREATE TYPE "sequence_step_kind" AS ENUM ('email', 'wait');
CREATE TYPE "enrolment_status" AS ENUM ('active', 'held', 'finished', 'stopped');
CREATE TYPE "enrolment_stop_reason" AS ENUM ('reply', 'bounce', 'unsubscribe', 'complaint', 'suppressed', 'manual', 'pipeline_exit', 'excluded', 'sequence_archived', 'person_deleted');

-- FR-CRMS-11: where a person came from (required to enrol) and, if known, their country.
ALTER TABLE "people" ADD COLUMN "source" TEXT,
ADD COLUMN "country" CHAR(2);

ALTER TABLE "mail_outbound" ADD COLUMN "sequence_enrolment_id" UUID,
ADD COLUMN "sequence_step_id" UUID;

CREATE TABLE "region_policies" (
    "workspace_id" UUID NOT NULL,
    "region" "region_code" NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "lawful_basis" TEXT,
    "updated_by_member_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "region_policies_pkey" PRIMARY KEY ("workspace_id","region")
);

CREATE TABLE "outreach_exclusions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "address" TEXT,
    "domain" TEXT,
    "reason" "exclusion_reason" NOT NULL,
    "account_manager_name" TEXT,
    "source" TEXT NOT NULL,
    "external_ref" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,
    "removed_note" TEXT,

    CONSTRAINT "outreach_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sequences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "sequence_status" NOT NULL DEFAULT 'draft',
    "pipeline_id" UUID,
    "stop_on_pipeline_exit" BOOLEAN NOT NULL DEFAULT true,
    "time_zone" TEXT NOT NULL,
    "window_start_minute" INTEGER NOT NULL DEFAULT 540,
    "window_end_minute" INTEGER NOT NULL DEFAULT 1020,
    "window_days" INTEGER NOT NULL DEFAULT 31,
    "created_by" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sequence_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "sequence_step_kind" NOT NULL,
    "template_id" UUID,
    "reply_in_thread" BOOLEAN NOT NULL DEFAULT false,
    "wait_days" INTEGER,
    "business_days" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sequence_enrolments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "deal_id" UUID,
    "status" "enrolment_status" NOT NULL DEFAULT 'active',
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ,
    "waiting_outbound_id" UUID,
    "held_reason" TEXT,
    "stop_reason" "enrolment_stop_reason",
    "stop_detail" TEXT,
    "enrolled_by" JSONB NOT NULL,
    "enrolled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "stopped_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sequence_enrolments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outreach_exclusions_workspace_id_created_at_idx" ON "outreach_exclusions"("workspace_id", "created_at");
CREATE UNIQUE INDEX "outreach_exclusions_live_address_key" ON "outreach_exclusions"("workspace_id", "address") WHERE "removed_at" IS NULL AND "address" IS NOT NULL;
CREATE UNIQUE INDEX "outreach_exclusions_live_domain_key" ON "outreach_exclusions"("workspace_id", "domain") WHERE "removed_at" IS NULL AND "domain" IS NOT NULL;
CREATE INDEX "sequences_workspace_id_status_idx" ON "sequences"("workspace_id", "status");
CREATE UNIQUE INDEX "sequence_steps_sequence_id_position_key" ON "sequence_steps"("sequence_id", "position");
CREATE UNIQUE INDEX "sequence_enrolments_sequence_id_person_id_key" ON "sequence_enrolments"("sequence_id", "person_id");
CREATE INDEX "sequence_enrolments_status_next_run_at_idx" ON "sequence_enrolments"("status", "next_run_at");
CREATE INDEX "sequence_enrolments_workspace_id_person_id_idx" ON "sequence_enrolments"("workspace_id", "person_id");
CREATE UNIQUE INDEX "sequence_enrolments_waiting_outbound_id_key" ON "sequence_enrolments"("waiting_outbound_id");
CREATE INDEX "mail_outbound_sequence_enrolment_id_idx" ON "mail_outbound"("sequence_enrolment_id");

ALTER TABLE "region_policies" ADD CONSTRAINT "region_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "region_policies" ADD CONSTRAINT "region_policies_updated_by_member_id_fkey" FOREIGN KEY ("updated_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "outreach_exclusions" ADD CONSTRAINT "outreach_exclusions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_waiting_outbound_id_fkey" FOREIGN KEY ("waiting_outbound_id") REFERENCES "mail_outbound"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_sequence_enrolment_id_fkey" FOREIGN KEY ("sequence_enrolment_id") REFERENCES "sequence_enrolments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_sequence_step_id_fkey" FOREIGN KEY ("sequence_step_id") REFERENCES "sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the schema cannot say.
ALTER TABLE "people" ADD CONSTRAINT "people_country_iso" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');
ALTER TABLE "people" ADD CONSTRAINT "people_source_present" CHECK ("source" IS NULL OR length(btrim("source")) > 0);
ALTER TABLE "region_policies" ADD CONSTRAINT "region_policies_basis_for_default_blocked"
    CHECK (NOT "allowed" OR "region" NOT IN ('eu', 'uk', 'ca') OR length(btrim(coalesce("lawful_basis", ''))) > 0);
ALTER TABLE "outreach_exclusions" ADD CONSTRAINT "outreach_exclusions_one_target"
    CHECK (("address" IS NULL) <> ("domain" IS NULL));
ALTER TABLE "outreach_exclusions" ADD CONSTRAINT "outreach_exclusions_lower"
    CHECK (("address" IS NULL OR "address" = lower("address")) AND ("domain" IS NULL OR "domain" = lower("domain")));
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_window"
    CHECK ("window_start_minute" BETWEEN 0 AND 1439 AND "window_end_minute" BETWEEN 1 AND 1440
           AND "window_start_minute" < "window_end_minute" AND "window_days" BETWEEN 1 AND 127);
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_shape" CHECK (
    ("kind" = 'email' AND "template_id" IS NOT NULL AND "wait_days" IS NULL)
    OR ("kind" = 'wait' AND "template_id" IS NULL AND NOT "reply_in_thread" AND "wait_days" BETWEEN 1 AND 90));
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_state" CHECK (
    ("status" = 'stopped') = ("stop_reason" IS NOT NULL AND "stopped_at" IS NOT NULL)
    AND ("status" = 'held') = ("held_reason" IS NOT NULL)
    AND ("status" <> 'finished' OR "finished_at" IS NOT NULL));

-- Row-level security: every new table is a workspace's. No DELETE except steps (a draft's list is
-- rewritten): exclusions and enrolments end by a state change, so their history stays.
ALTER TABLE "region_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "region_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "region_policies"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "region_policies" TO bylinecrm_app;

ALTER TABLE "outreach_exclusions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_exclusions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "outreach_exclusions"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "outreach_exclusions" TO bylinecrm_app;

ALTER TABLE "sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sequences"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "sequences" TO bylinecrm_app;

ALTER TABLE "sequence_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequence_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sequence_steps"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "sequence_steps" TO bylinecrm_app;

ALTER TABLE "sequence_enrolments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequence_enrolments" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sequence_enrolments"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "sequence_enrolments" TO bylinecrm_app;
