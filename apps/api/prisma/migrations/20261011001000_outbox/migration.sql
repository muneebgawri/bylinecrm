-- P1-6 (#98): the transactional outbox. A mutation writes its domain event into `outbox_events` in
-- the SAME transaction as the change, so an event exists exactly when its change committed. A
-- relay delivers each row to the in-process consumers (the timeline, webhooks, stage rules, mail
-- re-matching) at least once; consumers are idempotent on the event's id.
--
-- Tenant table under row-level security in P0-2's shape. The app role may INSERT (a mutation
-- recording its event) and SELECT (its own workspace's events) and nothing else: delivery state is
-- written by the relay, which runs as the owner because it spans every workspace — the same split
-- as the webhook sweep and retention.

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    -- Insertion order, for the relay's scan. Not commit order: a later `seq` can commit first.
    "seq" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    -- The DomainEvent's `type`, duplicated out of the payload for inspection and indexing.
    "type" TEXT NOT NULL,
    -- The DomainEvent (@bylinecrm/shared), as published.
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Relay state (owner only): the consumers that have handled the event, and the retry schedule.
    "completed_consumers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "lease_until" TIMESTAMPTZ,
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    -- An event ends one way or not at all.
    CONSTRAINT "outbox_events_one_outcome" CHECK ("completed_at" IS NULL OR "failed_at" IS NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_seq_key" ON "outbox_events"("seq");
CREATE INDEX "outbox_events_workspace_id_created_at_idx" ON "outbox_events"("workspace_id", "created_at");
-- The relay's scan: open events only, in insertion order. Partial, so delivered history costs it nothing.
CREATE INDEX "outbox_events_open_seq_idx" ON "outbox_events"("seq") WHERE "completed_at" IS NULL AND "failed_at" IS NULL;
-- Retention's scan.
CREATE INDEX "outbox_events_completed_at_idx" ON "outbox_events"("completed_at");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security in P0-2's shape, and the append-only grant.
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "outbox_events"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "outbox_events" TO bylinecrm_app;
GRANT USAGE ON SEQUENCE "outbox_events_seq_seq" TO bylinecrm_app;

-- Consumers are idempotent on the event's id. The timeline: one entry per (event, record) — a
-- redelivered event writes nothing new. External entries (no event) keep their own key; NULL event
-- ids never collide.
ALTER TABLE "timeline_activities" ADD COLUMN "event_id" UUID;
CREATE UNIQUE INDEX "timeline_activities_workspace_id_event_id_target_type_targe_key" ON "timeline_activities"("workspace_id", "event_id", "target_type", "target_id");

-- Webhooks: one delivery per (event, endpoint). `event_id` was already the event's; now it is the
-- outbox row's id, so a redelivered event finds its deliveries instead of making new ones.
CREATE UNIQUE INDEX "webhook_deliveries_event_id_endpoint_id_key" ON "webhook_deliveries"("event_id", "endpoint_id");
