-- Bigin stage mapping: a workspace says which stage of its default pipeline each Bigin deal stage lands in.
-- A deal's link keeps the raw Bigin stage it was last read with (`snapshot.stage`), so the mapping can be
-- applied to imported deals without reading Bigin again; `stage_apply` is the last apply's progress.

CREATE TABLE "bigin_stage_mappings" (
    "workspace_id" UUID NOT NULL,
    "bigin_stage" TEXT NOT NULL,
    "stage_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bigin_stage_mappings_pkey" PRIMARY KEY ("workspace_id", "bigin_stage")
);

CREATE INDEX "bigin_stage_mappings_stage_id_idx" ON "bigin_stage_mappings"("stage_id");

ALTER TABLE "bigin_stage_mappings" ADD CONSTRAINT "bigin_stage_mappings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bigin_stage_mappings" ADD CONSTRAINT "bigin_stage_mappings_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bigin_stage_mappings" ADD CONSTRAINT "bigin_stage_mappings_bigin_stage"
    CHECK (length("bigin_stage") BETWEEN 1 AND 200);

ALTER TABLE "bigin_stage_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bigin_stage_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "bigin_stage_mappings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "bigin_stage_mappings" TO bylinecrm_app;

ALTER TABLE "bigin_import_settings" ADD COLUMN "stage_apply" JSONB;
