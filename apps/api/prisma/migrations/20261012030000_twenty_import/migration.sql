-- P4-4 The Twenty importer (doc 48 §11). docs/design-notes/P4-4.md.

CREATE TYPE "twenty_import_run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "twenty_import_mode" AS ENUM ('full', 'changes');

CREATE TABLE "twenty_import_settings" (
    "workspace_id" UUID NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_ciphertext" TEXT NOT NULL,
    "api_key_last4" TEXT NOT NULL,
    "configured_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "twenty_import_settings_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE "twenty_import_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "status" "twenty_import_run_status" NOT NULL DEFAULT 'queued',
    "mode" "twenty_import_mode" NOT NULL,
    "since" TIMESTAMPTZ,
    "phase" TEXT,
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "report" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "started_by_id" UUID,
    "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "twenty_import_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "twenty_import_links" (
    "workspace_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "local_type" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "label" TEXT,
    "external_updated_at" TIMESTAMPTZ,
    "imported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "twenty_import_links_pkey" PRIMARY KEY ("workspace_id","object","external_id")
);

CREATE INDEX "twenty_import_runs_workspace_id_queued_at_idx" ON "twenty_import_runs"("workspace_id", "queued_at" DESC);
CREATE INDEX "twenty_import_links_workspace_id_local_type_local_id_idx" ON "twenty_import_links"("workspace_id", "local_type", "local_id");
-- One run at a time per workspace: a second start while one is queued or running is refused.
CREATE UNIQUE INDEX "twenty_import_runs_one_live_per_workspace" ON "twenty_import_runs"("workspace_id") WHERE "status" IN ('queued', 'running');

ALTER TABLE "twenty_import_settings" ADD CONSTRAINT "twenty_import_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "twenty_import_settings" ADD CONSTRAINT "twenty_import_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "twenty_import_runs" ADD CONSTRAINT "twenty_import_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "twenty_import_runs" ADD CONSTRAINT "twenty_import_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "twenty_import_links" ADD CONSTRAINT "twenty_import_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the schema cannot say.
ALTER TABLE "twenty_import_settings" ADD CONSTRAINT "twenty_import_settings_shape"
    CHECK (length(btrim("base_url")) > 0 AND length(btrim("api_key_ciphertext")) > 0);
ALTER TABLE "twenty_import_runs" ADD CONSTRAINT "twenty_import_runs_state" CHECK (
    ("status" IN ('succeeded', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL)
    AND ("status" <> 'queued' OR "started_at" IS NULL)
    AND ("status" <> 'failed' OR "error" IS NOT NULL));
ALTER TABLE "twenty_import_links" ADD CONSTRAINT "twenty_import_links_names"
    CHECK (length("object") > 0 AND length("external_id") > 0 AND length("local_type") > 0);

-- Row-level security: every new table is a workspace's. The settings row is deleted when the
-- connection is removed; runs and links stay (a run is history, a link is what makes a run repeatable).
ALTER TABLE "twenty_import_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twenty_import_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "twenty_import_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "twenty_import_settings" TO bylinecrm_app;

ALTER TABLE "twenty_import_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twenty_import_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "twenty_import_runs"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "twenty_import_runs" TO bylinecrm_app;

ALTER TABLE "twenty_import_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "twenty_import_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "twenty_import_links"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "twenty_import_links" TO bylinecrm_app;
