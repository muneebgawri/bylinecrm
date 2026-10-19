-- BIGIN-1 (FR-CRMS-25): the Bigin importer, a direct one-way sync Zoho Bigin → BylineCRM.
-- docs/design-notes/BIGIN-1.md. The same shape as the Twenty importer's tables (P4-4).

CREATE TYPE "bigin_import_run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "bigin_import_mode" AS ENUM ('full', 'changes');

CREATE TABLE "bigin_import_settings" (
    "workspace_id" UUID NOT NULL,
    "accounts_url" TEXT NOT NULL,
    "api_url" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_ciphertext" TEXT NOT NULL,
    "refresh_token_ciphertext" TEXT NOT NULL,
    "refresh_token_last4" TEXT NOT NULL,
    "configured_by_id" UUID,
    "sync_interval" TEXT NOT NULL DEFAULT 'off',
    "sync_failures" INTEGER NOT NULL DEFAULT 0,
    "sync_last_error" TEXT,
    "cutover_at" TIMESTAMPTZ,
    "create_members_role_id" UUID,
    "cursors" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bigin_import_settings_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE "bigin_import_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "status" "bigin_import_run_status" NOT NULL DEFAULT 'queued',
    "mode" "bigin_import_mode" NOT NULL,
    "phase" TEXT,
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "report" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "scheduled" BOOLEAN NOT NULL DEFAULT false,
    "started_by_id" UUID,
    "create_members_role_id" UUID,
    "accounts_created" INTEGER NOT NULL DEFAULT 0,
    "queued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bigin_import_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bigin_import_links" (
    "workspace_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "local_type" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "external_updated_at" TIMESTAMPTZ,
    "imported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_since" TIMESTAMPTZ,

    CONSTRAINT "bigin_import_links_pkey" PRIMARY KEY ("workspace_id","object","external_id")
);

CREATE INDEX "bigin_import_runs_workspace_id_queued_at_idx" ON "bigin_import_runs"("workspace_id", "queued_at" DESC);
CREATE INDEX "bigin_import_links_workspace_id_local_type_local_id_idx" ON "bigin_import_links"("workspace_id", "local_type", "local_id");
CREATE INDEX "bigin_import_links_workspace_id_missing_since_idx" ON "bigin_import_links"("workspace_id", "missing_since");
-- One run at a time per workspace: a second start while one is queued or running is refused.
CREATE UNIQUE INDEX "bigin_import_runs_one_live_per_workspace" ON "bigin_import_runs"("workspace_id") WHERE "status" IN ('queued', 'running');

ALTER TABLE "bigin_import_settings" ADD CONSTRAINT "bigin_import_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bigin_import_settings" ADD CONSTRAINT "bigin_import_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bigin_import_settings" ADD CONSTRAINT "bigin_import_settings_create_members_role_id_fkey" FOREIGN KEY ("create_members_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bigin_import_runs" ADD CONSTRAINT "bigin_import_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bigin_import_runs" ADD CONSTRAINT "bigin_import_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bigin_import_runs" ADD CONSTRAINT "bigin_import_runs_create_members_role_id_fkey" FOREIGN KEY ("create_members_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bigin_import_links" ADD CONSTRAINT "bigin_import_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the schema cannot say.
ALTER TABLE "bigin_import_settings" ADD CONSTRAINT "bigin_import_settings_shape" CHECK (
    length(btrim("accounts_url")) > 0 AND length(btrim("api_url")) > 0 AND length(btrim("client_id")) > 0
    AND length(btrim("client_secret_ciphertext")) > 0 AND length(btrim("refresh_token_ciphertext")) > 0);
ALTER TABLE "bigin_import_settings" ADD CONSTRAINT "bigin_import_settings_sync"
    CHECK ("sync_interval" IN ('off', '15m', 'hourly', 'daily') AND "sync_failures" >= 0);
ALTER TABLE "bigin_import_runs" ADD CONSTRAINT "bigin_import_runs_state" CHECK (
    ("status" IN ('succeeded', 'failed', 'cancelled')) = ("finished_at" IS NOT NULL)
    AND ("status" <> 'queued' OR "started_at" IS NULL)
    AND ("status" <> 'failed' OR "error" IS NOT NULL));
ALTER TABLE "bigin_import_links" ADD CONSTRAINT "bigin_import_links_names"
    CHECK (length("object") > 0 AND length("external_id") > 0 AND length("local_type") > 0);

-- Row-level security: every new table is a workspace's. The settings row is deleted when the
-- connection is removed; runs and links stay (a run is history, a link is what makes a run repeatable).
ALTER TABLE "bigin_import_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bigin_import_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "bigin_import_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "bigin_import_settings" TO bylinecrm_app;

ALTER TABLE "bigin_import_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bigin_import_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "bigin_import_runs"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "bigin_import_runs" TO bylinecrm_app;

ALTER TABLE "bigin_import_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bigin_import_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "bigin_import_links"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "bigin_import_links" TO bylinecrm_app;

-- Cross-source dedup (BIGIN-1): a record imported from Twenty carries Bigin's id in the `biginrecordid`
-- custom field; the Bigin importer finds it by that value, a page at a time.
CREATE INDEX "companies_custom_biginrecordid_idx" ON "companies"("workspace_id", ("custom"->>'biginrecordid')) WHERE "custom" ? 'biginrecordid';
CREATE INDEX "people_custom_biginrecordid_idx" ON "people"("workspace_id", ("custom"->>'biginrecordid')) WHERE "custom" ? 'biginrecordid';
CREATE INDEX "opportunities_custom_biginrecordid_idx" ON "opportunities"("workspace_id", ("custom"->>'biginrecordid')) WHERE "custom" ? 'biginrecordid';
