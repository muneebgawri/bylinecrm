-- A template is its author's own unless they make it public: a member reads their own templates and the public
-- ones, never another member's private template. An administrator reads them all. Templates written before this
-- were readable by everyone, so they start public; nobody loses one they used. A new template starts private.

-- CreateEnum
CREATE TYPE "template_visibility" AS ENUM ('private', 'public');

-- AlterTable
ALTER TABLE "email_templates"
    ADD COLUMN "visibility" "template_visibility" NOT NULL DEFAULT 'public',
    ADD COLUMN "owner_member_id" UUID;

-- The author, where a member wrote it. An import, a key or the system owns none: such a template stays public.
UPDATE "email_templates"
   SET "owner_member_id" = ("created_by" ->> 'id')::uuid
 WHERE "created_by" ->> 'kind' = 'member' AND "created_by" ->> 'id' IS NOT NULL;

ALTER TABLE "email_templates" ALTER COLUMN "visibility" SET DEFAULT 'private';

-- AddForeignKey: a member removed leaves their templates ownerless, readable by administrators.
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_owner_member_id_fkey"
    FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "email_templates_workspace_id_owner_member_id_idx" ON "email_templates"("workspace_id", "owner_member_id");
