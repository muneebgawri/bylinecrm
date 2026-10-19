-- GUARD-1 (#202, FR-CRMS-21): the recipient guard's audit — every block on a send, a reply, a scheduled send, a
-- sequence enrolment or step, every warning, and every manager let through — and the notification that tells
-- reviewers of a member's repeated blocks. Two capabilities: `guardrail:review` and `record:export_all`.

-- CreateEnum
CREATE TYPE "guardrail_kind" AS ENUM ('suppressed', 'excluded_customer', 'excluded_account_managed', 'owned_by_other', 'in_negotiation', 'cold_to_known', 'repeat_blocks');
CREATE TYPE "guardrail_outcome" AS ENUM ('blocked', 'warned', 'allowed');
CREATE TYPE "guardrail_severity" AS ENUM ('low', 'medium', 'high');
CREATE TYPE "guardrail_path" AS ENUM ('send', 'reply', 'scheduled_send', 'sequence_enrol', 'sequence_step', 'repeat_blocks');

-- AlterEnum
ALTER TYPE "notification_kind" ADD VALUE 'guardrail_repeat_blocks';

-- CreateTable
CREATE TABLE "guardrail_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "kind" "guardrail_kind" NOT NULL,
    "outcome" "guardrail_outcome" NOT NULL,
    "severity" "guardrail_severity" NOT NULL,
    "path" "guardrail_path" NOT NULL,
    "actor_member_id" UUID,
    "owner_member_id" UUID,
    "person_id" UUID,
    "company_id" UUID,
    "address" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "notified_member_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "dedupe_key" TEXT,
    "legitimate_at" TIMESTAMPTZ,
    "legitimate_by_member_id" UUID,
    "legitimate_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardrail_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guardrail_events_workspace_id_created_at_idx" ON "guardrail_events"("workspace_id", "created_at" DESC);
CREATE INDEX "guardrail_events_workspace_id_actor_member_id_created_at_idx" ON "guardrail_events"("workspace_id", "actor_member_id", "created_at");
-- One `repeat_blocks` per member per day: the tally inserts with its key, and a second insert does nothing.
CREATE UNIQUE INDEX "guardrail_events_workspace_id_dedupe_key_key" ON "guardrail_events"("workspace_id", "dedupe_key");

-- Marked legitimate: when and why, together or not at all.
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_legitimate_shape"
    CHECK (("legitimate_at" IS NULL) = ("legitimate_reason" IS NULL));

-- AddForeignKey
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_actor_member_id_fkey" FOREIGN KEY ("actor_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_legitimate_by_member_id_fkey" FOREIGN KEY ("legitimate_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security: a workspace's events are its own; the service decides who reads them (`guardrail:review`).
ALTER TABLE "guardrail_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guardrail_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "guardrail_events"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- An audit: never deleted by the app; a review only marks it.
GRANT SELECT, INSERT, UPDATE ON "guardrail_events" TO bylinecrm_app;

-- Notifications: about a task, a transfer, or a guardrail event — exactly one.
ALTER TABLE "notifications" ADD COLUMN "guardrail_event_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_guardrail_event_id_fkey" FOREIGN KEY ("guardrail_event_id") REFERENCES "guardrail_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "notifications_member_id_kind_guardrail_event_id_key" ON "notifications"("member_id", "kind", "guardrail_event_id");
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing"
    CHECK (num_nonnulls("task_id", "transfer_id", "guardrail_event_id") = 1);

-- The `manager` system role reviews guardrail events and exports every record (FR-CRMS-21).
INSERT INTO "role_permissions" ("id", "workspace_id", "role_id", "capability")
SELECT gen_random_uuid(), r."workspace_id", r."id", c.capability
FROM "roles" r
CROSS JOIN (VALUES ('guardrail:review'), ('record:export_all')) AS c(capability)
WHERE r."name" = 'manager' AND r."is_system"
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role_id" = r."id" AND p."capability" = c.capability);
