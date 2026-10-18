-- #192: a sequence has an owner and is shared (as every sequence was) or private (the owner and
-- admins only); members are told about their tasks (a notification per member, kind and task) and
-- get a daily digest unless they turn it off. Expand-only: every existing sequence stays shared.
-- CreateEnum
CREATE TYPE "sequence_visibility" AS ENUM ('shared', 'private');

-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('task_assigned', 'task_due');

-- AlterTable
ALTER TABLE "sequences" ADD COLUMN     "owner_member_id" UUID,
ADD COLUMN     "visibility" "sequence_visibility" NOT NULL DEFAULT 'shared';

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "task_digest" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "task_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_member_id_created_at_idx" ON "notifications"("member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_member_id_kind_task_id_key" ON "notifications"("member_id", "kind", "task_id");

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: a workspace's notifications are its own (which member's is the service's filter).
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "notifications"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO bylinecrm_app;

-- Back-fill: a sequence's owner is the member who made it, or the member whose API key did.
UPDATE "sequences" s
SET "owner_member_id" = m."id"
FROM "workspace_members" m
WHERE s."created_by"->>'kind' = 'member'
  AND m."id"::text = s."created_by"->>'id'
  AND m."workspace_id" = s."workspace_id";

UPDATE "sequences" s
SET "owner_member_id" = k."created_by_id"
FROM "api_keys" k
WHERE s."owner_member_id" IS NULL
  AND s."created_by"->>'kind' = 'api_key'
  AND k."id"::text = s."created_by"->>'id'
  AND k."workspace_id" = s."workspace_id";
