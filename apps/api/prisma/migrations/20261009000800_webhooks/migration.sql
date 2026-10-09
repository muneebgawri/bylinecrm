-- P1-5: outbound webhooks (doc 48 §8; doc 49 §5). Two tenant tables under row-level security in
-- P0-2's shape: the endpoints a workspace registers, and one delivery row per (endpoint, event)
-- with how it went. The app role may read, insert and update both; it may not delete either —
-- an endpoint is retired by `deleted_at`, and delivery rows are pruned by the retention job as
-- the owner, across workspaces, where the retention constants say so.

-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'delivering', 'succeeded', 'failed', 'dead');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    -- The signing secret, encrypted with the application's secrets key (it must be usable, so it
    -- cannot be a hash); `secret_prefix` is the part a list may show.
    "secret_ciphertext" TEXT NOT NULL,
    "secret_prefix" TEXT NOT NULL,
    "previous_secret_ciphertext" TEXT,
    "previous_secret_expires_at" TIMESTAMPTZ,
    -- Catalogue event types, or '*' for every one.
    "events" TEXT[] NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
    -- A previous secret is kept with its expiry or not at all.
    CONSTRAINT "webhook_endpoints_previous_secret_pair" CHECK (("previous_secret_ciphertext" IS NULL) = ("previous_secret_expires_at" IS NULL)),
    CONSTRAINT "webhook_endpoints_consecutive_failures_nonneg" CHECK ("consecutive_failures" >= 0)
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_deliveries_attempts_nonneg" CHECK ("attempts" >= 0)
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_workspace_id_deleted_at_idx" ON "webhook_endpoints"("workspace_id", "deleted_at");
CREATE INDEX "webhook_deliveries_workspace_id_endpoint_id_created_at_idx" ON "webhook_deliveries"("workspace_id", "endpoint_id", "created_at" DESC);
CREATE INDEX "webhook_deliveries_status_created_at_idx" ON "webhook_deliveries"("status", "created_at");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security in P0-2's shape; no DELETE for the app role on either table.
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "webhook_endpoints"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "webhook_endpoints" TO bylinecrm_app;

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "webhook_deliveries"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "webhook_deliveries" TO bylinecrm_app;
