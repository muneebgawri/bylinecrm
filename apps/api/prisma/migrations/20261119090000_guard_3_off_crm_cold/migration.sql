-- GUARD-3: cold mail sent outside the CRM. Expand only: one guardrail kind, one notification kind, one setting
-- with a default — nothing rewritten, no backfill. Events reuse `guardrail_events` and the GUARD-2 index on
-- (workspace_id, kind, actor_member_id, created_at).

ALTER TYPE "guardrail_kind" ADD VALUE IF NOT EXISTS 'off_crm_cold';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'guardrail_off_crm_cold';

ALTER TABLE "guardrail_settings" ADD COLUMN "off_crm_cold_alerts" BOOLEAN NOT NULL DEFAULT true;
