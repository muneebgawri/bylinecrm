-- P4-2 The enricher: free sources, "better than what is there" (FR-CRMS-15). docs/design-notes/P4-2.md.

-- A company's logo, as a URL: the website source fills it; a member may set it too.
ALTER TABLE "companies" ADD COLUMN "logo_url" TEXT;

CREATE TYPE "enrichment_answer_status" AS ENUM ('answered', 'no_answer', 'failed');

CREATE TABLE "enrichment_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "object" "record_object" NOT NULL,
    "record_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "enrichment_answer_status" NOT NULL,
    "value" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "asked_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_answers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "enrichment_settings" (
    "workspace_id" UUID NOT NULL,
    "reask_after_days" INTEGER NOT NULL DEFAULT 90,
    "disabled_sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updated_by_member_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "enrichment_settings_pkey" PRIMARY KEY ("workspace_id")
);

CREATE INDEX "enrichment_answers_workspace_id_object_record_id_asked_at_idx" ON "enrichment_answers"("workspace_id", "object", "record_id", "asked_at" DESC);
CREATE INDEX "enrichment_answers_workspace_id_asked_at_idx" ON "enrichment_answers"("workspace_id", "asked_at");

ALTER TABLE "enrichment_answers" ADD CONSTRAINT "enrichment_answers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "enrichment_settings" ADD CONSTRAINT "enrichment_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "enrichment_settings" ADD CONSTRAINT "enrichment_settings_updated_by_member_id_fkey" FOREIGN KEY ("updated_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the schema cannot say: no answer is no answer — a value exists exactly when the source
-- answered, and is never empty; an enriched record is a person or a company; the re-ask age is
-- within what the API offers (ENRICHMENT_LIMITS in @bylinecrm/shared); an applied answer was answered.
ALTER TABLE "enrichment_answers" ADD CONSTRAINT "enrichment_answers_value_when_answered"
    CHECK (("status" = 'answered') = ("value" IS NOT NULL) AND ("value" IS NULL OR length("value") > 0));
ALTER TABLE "enrichment_answers" ADD CONSTRAINT "enrichment_answers_object"
    CHECK ("object" IN ('person', 'company'));
ALTER TABLE "enrichment_answers" ADD CONSTRAINT "enrichment_answers_applied_means_answered"
    CHECK (NOT "applied" OR "status" = 'answered');
ALTER TABLE "enrichment_settings" ADD CONSTRAINT "enrichment_settings_reask_after_days_range"
    CHECK ("reask_after_days" BETWEEN 1 AND 365);

-- Row-level security: both tables are a workspace's. The app role never deletes: an answer is
-- history, the settings row an override that is updated.
ALTER TABLE "enrichment_answers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrichment_answers" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "enrichment_answers"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "enrichment_answers" TO bylinecrm_app;

ALTER TABLE "enrichment_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrichment_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "enrichment_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "enrichment_settings" TO bylinecrm_app;
