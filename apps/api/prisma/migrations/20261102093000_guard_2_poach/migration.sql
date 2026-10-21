-- GUARD-2 (#203, FR-CRMS-22): poaching detected from mail that left (Gmail sync and CRM sends alike). A new
-- guardrail kind, the bell notification that tells the owner and the reviewers, and an index for the detector's
-- per-sender lookups (dedupe window, 7-day severity ladder). No new table: events go to `guardrail_events`
-- (RLS from GUARD-1) and notifications to `notifications` (RLS from #192).

-- AlterEnum
ALTER TYPE "guardrail_kind" ADD VALUE IF NOT EXISTS 'poach_suspected';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'guardrail_poach_suspected';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "guardrail_events_workspace_id_kind_actor_member_id_created_at_idx" ON "guardrail_events"("workspace_id", "kind", "actor_member_id", "created_at");
