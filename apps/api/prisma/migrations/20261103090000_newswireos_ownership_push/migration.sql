-- PNW-765: completed ownership transfers pushed to NewswireOS. Off until an admin turns it on.
ALTER TABLE "newswireos_settings" ADD COLUMN "push_ownership" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "newswireos_ownership_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "record_type" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "matched" BOOLEAN,
    "customers" JSONB NOT NULL DEFAULT '[]',
    "reason_code" TEXT,
    "http_status" INTEGER,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "newswireos_ownership_deliveries_pkey" PRIMARY KEY ("id")
);

-- One push per event: a redelivered event writes nothing new.
CREATE UNIQUE INDEX "newswireos_ownership_deliveries_workspace_id_event_id_key" ON "newswireos_ownership_deliveries"("workspace_id", "event_id");
CREATE INDEX "newswireos_ownership_deliveries_workspace_id_created_at_idx" ON "newswireos_ownership_deliveries"("workspace_id", "created_at");

ALTER TABLE "newswireos_ownership_deliveries" ADD CONSTRAINT "newswireos_ownership_deliveries_shape"
    CHECK ("record_type" IN ('person', 'company')
        AND "status" IN ('pending', 'retrying', 'delivered', 'not_ready', 'failed', 'skipped')
        AND "attempts" >= 0);

ALTER TABLE "newswireos_ownership_deliveries" ADD CONSTRAINT "newswireos_ownership_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security in P0-2's shape.
ALTER TABLE "newswireos_ownership_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "newswireos_ownership_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "newswireos_ownership_deliveries"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- A delivery log: written and updated by the app, never deleted by it (the workspace's deletion cascades).
GRANT SELECT, INSERT, UPDATE ON "newswireos_ownership_deliveries" TO bylinecrm_app;
