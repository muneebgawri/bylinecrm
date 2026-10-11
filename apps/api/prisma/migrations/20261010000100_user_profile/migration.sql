-- P1-UI-10: the display name is the person's, not the seat's (exit check item 11).
-- One definition: `users.display_name`, read wherever a member is named, in every workspace.
-- `workspace_members.display_name` (P1-1b) is folded into it and dropped, so nothing keeps two copies in step.

ALTER TABLE "users" ADD COLUMN "display_name" TEXT,
                    ADD COLUMN "profile_completed_at" TIMESTAMPTZ;

-- Carry over the name each person already has: their first seat's, else their address's local part.
UPDATE "users" u SET "display_name" = COALESCE(
    (SELECT m."display_name" FROM "workspace_members" m
      WHERE m."user_id" = u."id" AND m."display_name" IS NOT NULL
      ORDER BY m."created_at" LIMIT 1),
    split_part(u."email", '@', 1));

ALTER TABLE "workspace_members" DROP COLUMN "display_name";

-- The person edits their own name through the restricted client: a column-level grant (the two
-- profile columns and the timestamp Prisma maintains) and a policy that matches one row, theirs.
-- Members of a workspace already read each other's `users` row (P0-2 policy members_of_current_workspace).
GRANT UPDATE ("display_name", "profile_completed_at", "updated_at") ON "users" TO bylinecrm_app;
CREATE POLICY self_profile ON "users"
    FOR UPDATE TO bylinecrm_app
    USING (id = app_user_id())
    WITH CHECK (id = app_user_id());
