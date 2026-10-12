-- #141: the history of region policy changes — who opened or closed a region, when, and on what lawful basis.
-- Append-only for the app role (SELECT, INSERT); written in the same transaction as the policy change.
CREATE TABLE "region_policy_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "region" "region_code" NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "lawful_basis" TEXT,
    "changed_by_member_id" UUID,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "region_policy_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "region_policy_changes_workspace_id_changed_at_idx" ON "region_policy_changes"("workspace_id", "changed_at");

ALTER TABLE "region_policy_changes" ADD CONSTRAINT "region_policy_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "region_policy_changes" ADD CONSTRAINT "region_policy_changes_changed_by_member_id_fkey" FOREIGN KEY ("changed_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "region_policy_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "region_policy_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "region_policy_changes"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "region_policy_changes" TO bylinecrm_app;

-- A workspace that already overrode a region keeps that as its first recorded change.
INSERT INTO "region_policy_changes" ("workspace_id", "region", "allowed", "lawful_basis", "changed_by_member_id", "changed_at")
SELECT "workspace_id", "region", "allowed", "lawful_basis", "updated_by_member_id", "updated_at" FROM "region_policies";
