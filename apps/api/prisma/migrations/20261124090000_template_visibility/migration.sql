-- A template is its author's own unless they make it public: a member reads their own templates and the public ones,
-- never another member's private template. `template:read_all` (an admin's by construction, grantable to any role)
-- reads every one. Owner decisions: templates written before this become private to their author too, and one whose
-- author has left stays private, readable only with `template:read_all`. One no member wrote (a key, the system) or
-- one imported from Twenty stays public: it was never anyone's own.

-- CreateEnum
CREATE TYPE "template_visibility" AS ENUM ('private', 'public');

-- AlterTable
ALTER TABLE "email_templates"
    ADD COLUMN "visibility" "template_visibility" NOT NULL DEFAULT 'private',
    ADD COLUMN "owner_member_id" UUID;

-- The author, where a member wrote it and is still a member of the workspace.
UPDATE "email_templates" t
   SET "owner_member_id" = m."id"
  FROM "workspace_members" m
 WHERE t."created_by" ->> 'kind' = 'member'
   AND m."id"::text = t."created_by" ->> 'id'
   AND m."workspace_id" = t."workspace_id";

-- Public: written by no member, or a campaign imported from Twenty.
UPDATE "email_templates" t
   SET "visibility" = 'public'
 WHERE t."created_by" ->> 'kind' IS DISTINCT FROM 'member'
    OR EXISTS (
        SELECT 1 FROM "twenty_import_links" l
         WHERE l."workspace_id" = t."workspace_id" AND l."local_type" = 'template' AND l."local_id" = t."id"
    );

-- AddForeignKey: a member removed leaves their templates ownerless, readable with `template:read_all`.
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_owner_member_id_fkey"
    FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "email_templates_workspace_id_owner_member_id_idx" ON "email_templates"("workspace_id", "owner_member_id");
