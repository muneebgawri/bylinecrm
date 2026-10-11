-- P0-15 (#93): transactional mail owed, written in the transaction that makes it necessary and sent
-- by the mail relay after the commit (the same transactional-outbox shape as P1-6's outbox_events,
-- in its own table: an account's mail has no workspace, and the payload is a credential that must
-- never reach a domain-event consumer such as webhooks). `sealed` is the message sealed with
-- SECRETS_KEY and is wiped once the mail is sent or given up on.

CREATE TABLE "mail_outbox" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    -- A workspace's own mail (an invitation); null for an account's (verification, reset).
    "workspace_id" UUID,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Relay state (owner only).
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "lease_until" TIMESTAMPTZ,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ,
    "provider_message_id" TEXT,
    "failed_at" TIMESTAMPTZ,

    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mail_outbox_one_outcome" CHECK ("sent_at" IS NULL OR "failed_at" IS NULL)
);

CREATE UNIQUE INDEX "mail_outbox_seq_key" ON "mail_outbox"("seq");
CREATE UNIQUE INDEX "mail_outbox_idempotency_key_key" ON "mail_outbox"("idempotency_key");
CREATE INDEX "mail_outbox_sent_at_idx" ON "mail_outbox"("sent_at");
CREATE INDEX "mail_outbox_open_seq_idx" ON "mail_outbox"("seq") WHERE "sent_at" IS NULL AND "failed_at" IS NULL;

ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The app role may only add a mail for the workspace it is acting in (an invitation); it can never
-- read the table back, change it, or add an account's mail (workspace_id null fails the check).
ALTER TABLE "mail_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_insert ON "mail_outbox"
    FOR INSERT TO bylinecrm_app
    WITH CHECK (workspace_id = app_workspace_id());
GRANT INSERT ON "mail_outbox" TO bylinecrm_app;
GRANT USAGE ON SEQUENCE "mail_outbox_seq_seq" TO bylinecrm_app;
