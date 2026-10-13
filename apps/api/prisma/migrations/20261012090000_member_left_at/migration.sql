-- #147 A member is removed by marking when they left, never by deleting the row: the sends, enrolments
-- and timeline rows that name them stay attributable. Access ends at once — the workspace guard and the
-- user's workspace list read only seats with no left_at.
ALTER TABLE "workspace_members" ADD COLUMN "left_at" TIMESTAMPTZ;

DROP POLICY member_workspaces ON "workspaces";
CREATE POLICY member_workspaces ON "workspaces"
    FOR SELECT TO bylinecrm_app
    USING (EXISTS (
        SELECT 1 FROM "workspace_members" m
        WHERE m.workspace_id = "workspaces".id AND m.user_id = app_user_id() AND m.left_at IS NULL
    ));
