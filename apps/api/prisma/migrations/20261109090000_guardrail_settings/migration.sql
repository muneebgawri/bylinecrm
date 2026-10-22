-- GUARD-2: Settings → Guardrails. Whether a high poaching alert is emailed at once (off by default; the bell and
-- the digest always tell), and which members are shared mailboxes (outreach@) whose leads count as nobody's to the
-- recipient guard and the poaching detector. A new table only: no row means the defaults, nothing to backfill.
CREATE TABLE "guardrail_settings" (
    "workspace_id" UUID NOT NULL,
    "poach_email_at_once" BOOLEAN NOT NULL DEFAULT false,
    "shared_mailbox_member_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "guardrail_settings_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "guardrail_settings_shared_mailboxes_check" CHECK (cardinality("shared_mailbox_member_ids") <= 50)
);

ALTER TABLE "guardrail_settings" ADD CONSTRAINT "guardrail_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guardrail_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guardrail_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "guardrail_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "guardrail_settings" TO bylinecrm_app;
