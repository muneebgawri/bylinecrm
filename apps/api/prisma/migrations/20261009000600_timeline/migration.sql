-- P1-3: the timeline. One append-only list per record of what happened to it (PAR-013/014/015):
-- the record's own events, the notes/tasks/files on it (one row per record the thing is on), and
-- what integrations report (doc 48 §8). A tenant table under row-level security in P0-2's shape.
-- The app role may SELECT and INSERT and nothing else: there is no route that edits history, and
-- the grant is where that is enforced, not in the service.

-- CreateEnum
CREATE TYPE "linked_object" AS ENUM ('note', 'task', 'attachment');

-- CreateTable
CREATE TABLE "timeline_activities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "target_type" "record_object" NOT NULL,
    "target_id" UUID NOT NULL,
    -- `<object>.<action>`, `linked-<thing>.<action>` or `external.<kind>`.
    "kind" TEXT NOT NULL,
    "happened_at" TIMESTAMPTZ NOT NULL,
    -- TimelineActor (@bylinecrm/shared): a member, key, import, sync, system, rule or integration.
    "actor" JSONB NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "linked_type" "linked_object",
    "linked_id" UUID,
    -- External entries only: the integration's name and its idempotency key.
    "source" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeline_activities_pkey" PRIMARY KEY ("id"),
    -- A linked entry names its thing wholly or not at all; an external entry carries both keys.
    CONSTRAINT "timeline_activities_linked_pair" CHECK (("linked_type" IS NULL) = ("linked_id" IS NULL)),
    CONSTRAINT "timeline_activities_external_pair" CHECK (("source" IS NULL) = ("idempotency_key" IS NULL)),
    CONSTRAINT "timeline_activities_external_kind" CHECK (("source" IS NULL) OR ("kind" LIKE 'external.%'))
);

-- CreateIndex: an integration's key is unique per workspace; rows without one never collide
-- (NULLs are distinct), so the index needs no predicate.
CREATE UNIQUE INDEX "timeline_activities_workspace_id_source_idempotency_key_key" ON "timeline_activities"("workspace_id", "source", "idempotency_key");
CREATE INDEX "timeline_activities_workspace_id_target_type_target_id_happ_idx" ON "timeline_activities"("workspace_id", "target_type", "target_id", "happened_at" DESC);
CREATE INDEX "timeline_activities_workspace_id_linked_type_linked_id_idx" ON "timeline_activities"("workspace_id", "linked_type", "linked_id");

-- AddForeignKey
ALTER TABLE "timeline_activities" ADD CONSTRAINT "timeline_activities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security in P0-2's shape, and the append-only grant.
ALTER TABLE "timeline_activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timeline_activities" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "timeline_activities"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "timeline_activities" TO bylinecrm_app;
