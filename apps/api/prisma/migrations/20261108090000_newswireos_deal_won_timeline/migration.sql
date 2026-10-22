-- PNW-766: won deals pushed to NewswireOS (off until an admin turns it on), the client ids it answers with, and the
-- NewswireOS timeline events received on the hook. Schema only: nullable columns and new tables, nothing backfilled.
ALTER TABLE "newswireos_settings" ADD COLUMN "push_deal_won" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "people" ADD COLUMN "newswireos_customer_id" TEXT;
ALTER TABLE "companies" ADD COLUMN "newswireos_customer_id" TEXT;

CREATE TABLE "newswireos_deal_won_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "customer_id" TEXT,
    "parent_customer_id" TEXT,
    "reason_code" TEXT,
    "am_reason_code" TEXT,
    "http_status" INTEGER,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "newswireos_deal_won_deliveries_pkey" PRIMARY KEY ("id")
);

-- One push per event: a redelivered event writes nothing new.
CREATE UNIQUE INDEX "newswireos_deal_won_deliveries_workspace_id_event_id_key" ON "newswireos_deal_won_deliveries"("workspace_id", "event_id");
CREATE INDEX "newswireos_deal_won_deliveries_workspace_id_created_at_idx" ON "newswireos_deal_won_deliveries"("workspace_id", "created_at");

ALTER TABLE "newswireos_deal_won_deliveries" ADD CONSTRAINT "newswireos_deal_won_deliveries_shape"
    CHECK ("status" IN ('pending', 'retrying', 'delivered', 'not_ready', 'failed', 'skipped') AND "attempts" >= 0);

ALTER TABLE "newswireos_deal_won_deliveries" ADD CONSTRAINT "newswireos_deal_won_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "newswireos_timeline_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ,
    "payload" JSONB NOT NULL,
    "target_type" TEXT,
    "target_id" UUID,
    "matched_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newswireos_timeline_events_pkey" PRIMARY KEY ("id")
);

-- One row per delivery: NewswireOS retries until it gets a 2xx, and a redelivery is acknowledged, not applied twice.
CREATE UNIQUE INDEX "newswireos_timeline_events_workspace_id_event_id_key" ON "newswireos_timeline_events"("workspace_id", "event_id");
CREATE INDEX "newswireos_timeline_events_workspace_id_created_at_idx" ON "newswireos_timeline_events"("workspace_id", "created_at");

ALTER TABLE "newswireos_timeline_events" ADD CONSTRAINT "newswireos_timeline_events_shape"
    CHECK (("target_type" IS NULL) = ("target_id" IS NULL)
        AND ("target_type" IS NULL OR "target_type" IN ('person', 'company'))
        AND ("matched_by" IS NULL OR "matched_by" IN ('byline_contact_id', 'byline_company_id', 'email', 'domain')));

ALTER TABLE "newswireos_timeline_events" ADD CONSTRAINT "newswireos_timeline_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security in P0-2's shape.
ALTER TABLE "newswireos_deal_won_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "newswireos_deal_won_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "newswireos_deal_won_deliveries"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- A delivery log: written and updated by the app, never deleted by it (the workspace's deletion cascades).
GRANT SELECT, INSERT, UPDATE ON "newswireos_deal_won_deliveries" TO bylinecrm_app;

ALTER TABLE "newswireos_timeline_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "newswireos_timeline_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "newswireos_timeline_events"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- What was received, as received: appended, never edited.
GRANT SELECT, INSERT ON "newswireos_timeline_events" TO bylinecrm_app;
