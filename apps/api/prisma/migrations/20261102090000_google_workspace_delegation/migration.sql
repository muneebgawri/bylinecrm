-- #225: a Google Workspace service account with domain-wide delegation syncs (and sends from) members' Gmail
-- and reads their Calendar. A delegated mailbox is an ordinary mailbox row whose tokens the service account mints.
CREATE TYPE "mailbox_credential_source" AS ENUM ('oauth', 'delegation');

ALTER TABLE "mailboxes" ADD COLUMN "credential_source" "mailbox_credential_source" NOT NULL DEFAULT 'oauth';

-- A delegated mailbox is a personal Gmail mailbox without a refresh token of its own.
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_delegation_shape"
    CHECK ("credential_source" = 'oauth'
        OR ("purpose" = 'personal' AND "transport" = 'gmail' AND "refresh_token_ciphertext" IS NULL));

-- Credentials by status (TRANS-1), with a working delegated mailbox: Gmail, no refresh token, no SMTP2Go key.
ALTER TABLE "mailboxes" DROP CONSTRAINT "mailboxes_credentials_by_status";
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_credentials_by_status" CHECK (
    ("status" = 'disconnected' AND "refresh_token_ciphertext" IS NULL AND "access_token_ciphertext" IS NULL
        AND "transport_key_ciphertext" IS NULL)
    OR ("status" <> 'disconnected' AND "transport" = 'gmail' AND "credential_source" = 'oauth'
        AND "refresh_token_ciphertext" IS NOT NULL AND "transport_key_ciphertext" IS NULL)
    OR ("status" <> 'disconnected' AND "transport" = 'gmail' AND "credential_source" = 'delegation'
        AND "refresh_token_ciphertext" IS NULL AND "transport_key_ciphertext" IS NULL)
    OR ("status" <> 'disconnected' AND "transport" = 'smtp2go' AND "refresh_token_ciphertext" IS NULL
        AND "access_token_ciphertext" IS NULL AND "transport_key_ciphertext" IS NOT NULL
        AND "hook_secret_ciphertext" IS NOT NULL)
);

CREATE TABLE "google_workspace_delegations" (
    "workspace_id" UUID NOT NULL,
    "key_ciphertext" TEXT NOT NULL,
    "client_email" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "private_key_id_last4" TEXT NOT NULL,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded_member_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_check" JSONB,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "google_workspace_delegations_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "google_workspace_delegations" ADD CONSTRAINT "google_workspace_delegations_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "google_workspace_delegation_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_member_id" UUID,
    "subject_member_id" UUID,
    "mailbox_id" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_workspace_delegation_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "google_workspace_delegation_audit_workspace_id_created_at_idx"
    ON "google_workspace_delegation_audit"("workspace_id", "created_at");

ALTER TABLE "google_workspace_delegation_audit" ADD CONSTRAINT "google_workspace_delegation_audit_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "google_workspace_delegation_audit" ADD CONSTRAINT "google_workspace_delegation_audit_action"
    CHECK ("action" IN ('key_set', 'key_removed', 'domains_changed', 'member_excluded', 'member_included',
                        'checked', 'mail_sync_started', 'calendar_sync_started'));

-- Row-level security in P0-2's shape.
ALTER TABLE "google_workspace_delegations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_workspace_delegations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "google_workspace_delegations"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "google_workspace_delegations" TO bylinecrm_app;

-- The audit log: the application appends and reads; the retention sweep deletes old rows as the owner.
ALTER TABLE "google_workspace_delegation_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_workspace_delegation_audit" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "google_workspace_delegation_audit"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "google_workspace_delegation_audit" TO bylinecrm_app;
