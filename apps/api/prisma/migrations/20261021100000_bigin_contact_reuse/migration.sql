-- BIGIN-1: a Bigin Contact edited to hold a different person is a reuse, never an overwrite. The link keeps
-- what Bigin had when last read; a detected reuse is recorded for admins to see.

ALTER TABLE "bigin_import_links" ADD COLUMN "snapshot" JSONB;

CREATE TABLE "bigin_contact_reuses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "bigin_id" TEXT NOT NULL,
    "previous_person_id" UUID NOT NULL,
    "new_person_id" UUID NOT NULL,
    "run_id" UUID,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,

    CONSTRAINT "bigin_contact_reuses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bigin_contact_reuses_workspace_id_detected_at_idx" ON "bigin_contact_reuses"("workspace_id", "detected_at" DESC);
CREATE INDEX "bigin_contact_reuses_workspace_id_bigin_id_idx" ON "bigin_contact_reuses"("workspace_id", "bigin_id");

ALTER TABLE "bigin_contact_reuses" ADD CONSTRAINT "bigin_contact_reuses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bigin_contact_reuses" ADD CONSTRAINT "bigin_contact_reuses_people"
    CHECK (length("bigin_id") > 0 AND "previous_person_id" <> "new_person_id");

ALTER TABLE "bigin_contact_reuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bigin_contact_reuses" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "bigin_contact_reuses"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "bigin_contact_reuses" TO bylinecrm_app;
