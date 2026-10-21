-- OWN-1, owner decision 2 (2026-10-21): a transfer cooling period, set per workspace in Settings → Ownership.
-- No row means the default of 14 days.
CREATE TABLE "ownership_settings" (
    "workspace_id" UUID NOT NULL,
    "transfer_cooling_days" INTEGER NOT NULL DEFAULT 14,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ownership_settings_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "ownership_settings_cooling_days_check" CHECK ("transfer_cooling_days" BETWEEN 0 AND 90)
);

ALTER TABLE "ownership_settings" ADD CONSTRAINT "ownership_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ownership_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ownership_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "ownership_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "ownership_settings" TO bylinecrm_app;
