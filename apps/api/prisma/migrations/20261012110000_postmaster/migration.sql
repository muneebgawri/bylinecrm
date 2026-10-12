-- #129 (P3-2b, FR-CRMS-13): Postmaster Tools. One connected Google account per workspace, the user-reported
-- spam rate per sending domain and day, and what the last check learned from Postmaster about each domain.
-- CreateEnum
CREATE TYPE "postmaster_domain_status" AS ENUM ('not_connected', 'not_verified', 'ok', 'failed');

-- CreateEnum
CREATE TYPE "postmaster_connection_status" AS ENUM ('connected', 'reconnect_needed');

-- AlterTable
ALTER TABLE "sending_domains" ADD COLUMN     "postmaster_message" TEXT,
ADD COLUMN     "postmaster_status" "postmaster_domain_status" NOT NULL DEFAULT 'not_connected';

-- CreateTable
CREATE TABLE "sending_domain_stats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "spam_rate_bps" INTEGER NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sending_domain_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postmaster_connections" (
    "workspace_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "postmaster_connection_status" NOT NULL DEFAULT 'connected',
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refresh_token_ciphertext" TEXT NOT NULL,
    "access_token_ciphertext" TEXT NOT NULL,
    "access_expires_at" TIMESTAMPTZ NOT NULL,
    "last_error" TEXT,
    "connected_by_member_id" UUID NOT NULL,
    "connected_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "postmaster_connections_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sending_domain_stats_domain_id_day_key" ON "sending_domain_stats"("domain_id", "day");

-- AddForeignKey
ALTER TABLE "sending_domain_stats" ADD CONSTRAINT "sending_domain_stats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sending_domain_stats" ADD CONSTRAINT "sending_domain_stats_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "sending_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postmaster_connections" ADD CONSTRAINT "postmaster_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postmaster_connections" ADD CONSTRAINT "postmaster_connections_connected_by_member_id_fkey" FOREIGN KEY ("connected_by_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What the columns promise: the account's address is lower case; a rate is within 0–100%.
ALTER TABLE "postmaster_connections" ADD CONSTRAINT "postmaster_connections_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "sending_domain_stats" ADD CONSTRAINT "sending_domain_stats_rate_range" CHECK ("spam_rate_bps" BETWEEN 0 AND 10000);

-- Row-level security in P0-2's shape. A stat row is written once per day and replaced in place; the
-- connection is one row the workspace creates, updates (tokens) and deletes (disconnect).
ALTER TABLE "sending_domain_stats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sending_domain_stats" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sending_domain_stats"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "sending_domain_stats" TO bylinecrm_app;

ALTER TABLE "postmaster_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "postmaster_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "postmaster_connections"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "postmaster_connections" TO bylinecrm_app;
