-- P2-1: the workspace's Google OAuth client and the mailboxes connected through it (doc 48
-- FR-CRMS-1, D-237; doc 50 §E). Two tenant tables under row-level security in P0-2's shape.
-- Secrets and tokens are stored sealed by the application's secrets key (`SecretBox`); none is
-- ever returned by the API. A mailbox is never deleted by the app role: disconnecting is a status
-- with the tokens wiped, so the row keeps the address's place in the workspace and its history.

-- CreateEnum
CREATE TYPE "mailbox_purpose" AS ENUM ('personal', 'pool');

-- CreateEnum
CREATE TYPE "mailbox_status" AS ENUM ('connected', 'reconnect_needed', 'disconnected');

-- CreateTable
CREATE TABLE "google_oauth_clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    -- Sealed: the client secret is presented to Google, so a hash would not do.
    "client_secret_ciphertext" TEXT NOT NULL,
    -- The only part of the secret the API ever shows.
    "client_secret_last4" TEXT NOT NULL,
    "configured_by_id" UUID NOT NULL,
    -- When a mailbox first connected through this client: the end-to-end proof that it works.
    "verified_at" TIMESTAMPTZ,
    "last_check" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "google_oauth_clients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "google_oauth_clients_last4_len" CHECK (char_length("client_secret_last4") <= 4)
);

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "owner_member_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "purpose" "mailbox_purpose" NOT NULL,
    "status" "mailbox_status" NOT NULL,
    "granted_scopes" TEXT[] NOT NULL DEFAULT '{}',
    "refresh_token_ciphertext" TEXT,
    "access_token_ciphertext" TEXT,
    "access_expires_at" TIMESTAMPTZ,
    -- `{ code, message, at }` while the mailbox is not working; null otherwise.
    "last_error" JSONB,
    "connected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id"),
    -- One spelling per address, so the uniqueness below means what it says.
    CONSTRAINT "mailboxes_email_lower" CHECK ("email" = lower("email")),
    -- A mailbox that is not disconnected holds the refresh token that keeps it working; a
    -- disconnected one holds no token at all.
    CONSTRAINT "mailboxes_refresh_token_by_status" CHECK (
        ("status" = 'disconnected' AND "refresh_token_ciphertext" IS NULL AND "access_token_ciphertext" IS NULL)
        OR ("status" <> 'disconnected' AND "refresh_token_ciphertext" IS NOT NULL)
    ),
    -- An access token is kept with its expiry or not at all.
    CONSTRAINT "mailboxes_access_token_pair" CHECK (("access_token_ciphertext" IS NULL) = ("access_expires_at" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "google_oauth_clients_workspace_id_key" ON "google_oauth_clients"("workspace_id");
CREATE INDEX "mailboxes_workspace_id_owner_member_id_idx" ON "mailboxes"("workspace_id", "owner_member_id");
CREATE UNIQUE INDEX "mailboxes_workspace_id_email_key" ON "mailboxes"("workspace_id", "email");

-- AddForeignKey
ALTER TABLE "google_oauth_clients" ADD CONSTRAINT "google_oauth_clients_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "google_oauth_clients" ADD CONSTRAINT "google_oauth_clients_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security in P0-2's shape.
ALTER TABLE "google_oauth_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_oauth_clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "google_oauth_clients"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- An admin may remove the client once no live mailbox uses it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "google_oauth_clients" TO bylinecrm_app;

ALTER TABLE "mailboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mailboxes"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- No DELETE: disconnecting is a status with the tokens wiped.
GRANT SELECT, INSERT, UPDATE ON "mailboxes" TO bylinecrm_app;
