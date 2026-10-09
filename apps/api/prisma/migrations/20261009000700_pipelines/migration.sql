-- P1-2: pipelines, stages, stage history and stage rules (doc 48 FR-CRMS-9; PAR-007/008).
-- Every new table is a tenant table under row-level security in P0-2's shape. A deal now always
-- has a pipeline and a stage: existing workspaces get the default pipeline below and their deals
-- are placed in its first stage with a history row that says so (`reason = 'import'`).
--
-- The default stages here are the same list as DEFAULT_STAGES in @bylinecrm/shared, which seeds
-- every workspace created after this migration; `default-stages.spec.ts` holds the two together.

-- CreateEnum
CREATE TYPE "stage_kind" AS ENUM ('open', 'won', 'lost');
CREATE TYPE "stage_history_reason" AS ENUM ('manual', 'rule', 'import', 'close');
CREATE TYPE "stage_rule_event" AS ENUM ('email.replied', 'meeting.booked');

-- CreateTable
CREATE TABLE "pipelines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from clock_timestamp()),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- 1-based order in the pipeline. Unique per pipeline, checked at commit so a reorder can swap
    -- two rows inside one transaction.
    "position" INTEGER NOT NULL,
    "probability" SMALLINT NOT NULL,
    "kind" "stage_kind" NOT NULL DEFAULT 'open',
    "days_threshold" INTEGER,
    "colour" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pipeline_stages_pipeline_id_position_key" UNIQUE ("pipeline_id", "position") DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT "pipeline_stages_position_positive" CHECK ("position" >= 1),
    CONSTRAINT "pipeline_stages_probability_range" CHECK ("probability" BETWEEN 0 AND 100),
    CONSTRAINT "pipeline_stages_days_threshold_positive" CHECK ("days_threshold" IS NULL OR "days_threshold" >= 1)
);

-- CreateTable: one row per stage a deal entered, in order. The latest row is when the deal entered
-- the stage it is in; days-in-stage is computed from it and never stored.
CREATE TABLE "opportunity_stage_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "from_stage_id" UUID,
    "to_stage_id" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" JSONB NOT NULL,
    "reason" "stage_history_reason" NOT NULL,
    CONSTRAINT "opportunity_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "event" "stage_rule_event" NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "allow_backward" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "stage_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipelines_workspace_id_idx" ON "pipelines"("workspace_id");
CREATE UNIQUE INDEX "pipelines_workspace_id_name_key" ON "pipelines"("workspace_id", "name");
-- Exactly one default pipeline per workspace.
CREATE UNIQUE INDEX "pipelines_one_default_per_workspace" ON "pipelines"("workspace_id") WHERE "is_default";
CREATE INDEX "pipeline_stages_workspace_id_pipeline_id_idx" ON "pipeline_stages"("workspace_id", "pipeline_id");
CREATE INDEX "opportunity_stage_history_workspace_id_opportunity_id_enter_idx" ON "opportunity_stage_history"("workspace_id", "opportunity_id", "entered_at" DESC);
CREATE INDEX "stage_rules_workspace_id_event_idx" ON "stage_rules"("workspace_id", "event");
CREATE UNIQUE INDEX "stage_rules_pipeline_id_event_key" ON "stage_rules"("pipeline_id", "event");

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_rules" ADD CONSTRAINT "stage_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_rules" ADD CONSTRAINT "stage_rules_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_rules" ADD CONSTRAINT "stage_rules_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "pipeline_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: every existing workspace gets the default pipeline and its stages; every existing
-- deal is placed in that pipeline's first stage, with a history row saying the import did it.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "pipelines" ("workspace_id", "name", "is_default", "updated_at")
SELECT w."id", 'Sales pipeline', true, CURRENT_TIMESTAMP FROM "workspaces" w;

-- DEFAULT_STAGES (name, position, probability, kind, colour), in order.
INSERT INTO "pipeline_stages" ("workspace_id", "pipeline_id", "name", "position", "probability", "kind", "colour", "updated_at")
SELECT p."workspace_id", p."id", s.name, s.position, s.probability, s.kind::"stage_kind", s.colour, CURRENT_TIMESTAMP
FROM "pipelines" p
CROSS JOIN (VALUES
    ('New',       1,  10, 'open', 'neutral'),
    ('Contacted', 2,  20, 'open', 'info'),
    ('Replied',   3,  40, 'open', 'accent'),
    ('Meeting',   4,  60, 'open', 'warn'),
    ('Won',       5, 100, 'won',  'ok'),
    ('Lost',      6,   0, 'lost', 'bad')
) AS s(name, position, probability, kind, colour)
WHERE p."is_default";

-- AlterTable: the columns arrive nullable, are filled, then become NOT NULL. `closed_at` and
-- `lost_reason` are written by a close (a move into a won or lost stage) and cleared by a reopen.
ALTER TABLE "opportunities"
    ADD COLUMN "pipeline_id" UUID,
    ADD COLUMN "stage_id" UUID,
    ADD COLUMN "closed_at" TIMESTAMPTZ,
    ADD COLUMN "lost_reason" TEXT;
UPDATE "opportunities" o
SET "pipeline_id" = p."id", "stage_id" = s."id"
FROM "pipelines" p
JOIN "pipeline_stages" s ON s."pipeline_id" = p."id" AND s."position" = 1
WHERE p."workspace_id" = o."workspace_id" AND p."is_default";
ALTER TABLE "opportunities" ALTER COLUMN "pipeline_id" SET NOT NULL, ALTER COLUMN "stage_id" SET NOT NULL;

INSERT INTO "opportunity_stage_history" ("workspace_id", "opportunity_id", "from_stage_id", "to_stage_id", "entered_at", "actor", "reason")
SELECT o."workspace_id", o."id", NULL, o."stage_id", o."created_at", '{"kind":"system","id":null}'::jsonb, 'import'
FROM "opportunities" o;

-- CreateIndex
CREATE INDEX "opportunities_workspace_id_pipeline_id_stage_id_idx" ON "opportunities"("workspace_id", "pipeline_id", "stage_id");

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security, in P0-2's shape. None of these tables carries an owner: a pipeline and its
-- stages are workspace configuration; a history row's visibility follows its deal (the service
-- reads history through the deal, which carries the owner policy).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipelines" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "pipelines"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipelines" TO bylinecrm_app;

ALTER TABLE "pipeline_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "pipeline_stages"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipeline_stages" TO bylinecrm_app;

ALTER TABLE "opportunity_stage_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_stage_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "opportunity_stage_history"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "opportunity_stage_history" TO bylinecrm_app;

ALTER TABLE "stage_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stage_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "stage_rules"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "stage_rules" TO bylinecrm_app;
