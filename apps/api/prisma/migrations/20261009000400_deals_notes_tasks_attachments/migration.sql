-- P1-1b: opportunities (deals), notes, tasks, attachments, and the two small columns the package
-- needs on existing tables. Every new table is a tenant table under row-level security in P0-2's
-- shape; `opportunities` is owner-bearing and carries P1-1a's restrictive owner policy too.

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('todo', 'in_progress', 'done');

-- The currency a deal takes when the caller names none. A workspace setting; a later package
-- edits it, this one reads it.
ALTER TABLE "workspaces" ADD COLUMN "default_currency" CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_currency_upper"
    CHECK ("default_currency" = upper("default_currency"));

-- How a member is shown to other members (owner, assignee and contact pickers read it; emails do
-- not travel there). Defaults to the local part of the email at creation; a profile edits it later.
ALTER TABLE "workspace_members" ADD COLUMN "display_name" TEXT;
UPDATE "workspace_members" m SET "display_name" = split_part(u."email", '@', 1)
    FROM "users" u WHERE u."id" = m."user_id";

-- CreateTable
CREATE TABLE "opportunities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- Exact and integral: the currency's minor unit (PAR-007). Sums never round.
    "amount_minor" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "close_date" DATE,
    "probability" SMALLINT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from clock_timestamp()),
    "owner_id" UUID,
    "point_of_contact_id" UUID,
    "company_id" UUID,
    "created_by" JSONB NOT NULL,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("name", ''))) STORED,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "opportunities_currency_upper" CHECK ("currency" = upper("currency")),
    CONSTRAINT "opportunities_probability_range" CHECK ("probability" IS NULL OR ("probability" BETWEEN 0 AND 100)),
    CONSTRAINT "opportunities_amount_nonnegative" CHECK ("amount_minor" IS NULL OR "amount_minor" >= 0)
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    -- The editor's document, stored as given (RichText in @bylinecrm/shared).
    "body" JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}',
    -- Plain text the application derives from `body` on every write, for search and previews.
    "body_text" TEXT NOT NULL DEFAULT '',
    "author_id" UUID,
    "created_by" JSONB NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body_text", ''))) STORED,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable: one row per record a note is attached to (PAR-010). The target is polymorphic —
-- any record object — so it has no foreign key; records are only ever soft-deleted, so a target
-- never dangles, and the service checks the target exists in this workspace before writing it.
CREATE TABLE "note_targets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "target_type" "record_object" NOT NULL,
    "target_id" UUID NOT NULL,

    CONSTRAINT "note_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}',
    "body_text" TEXT NOT NULL DEFAULT '',
    "status" "task_status" NOT NULL DEFAULT 'todo',
    "due_at" TIMESTAMPTZ,
    "assignee_id" UUID,
    -- Set when `status` becomes `done`, cleared when it leaves it: one rule, in the service.
    "completed_at" TIMESTAMPTZ,
    "created_by" JSONB NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body_text", ''))) STORED,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
    -- The two columns agree by construction: done ⇔ completed.
    CONSTRAINT "tasks_completed_at_matches_status" CHECK (("status" = 'done') = ("completed_at" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "task_targets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "target_type" "record_object" NOT NULL,
    "target_id" UUID NOT NULL,

    CONSTRAINT "task_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a file on one record (PAR-016). The bytes live behind `FileStorage` under
-- `storage_key`; the row is the only way to reach them, and it is under the same policies.
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "target_type" "record_object" NOT NULL,
    "target_id" UUID NOT NULL,
    "author_id" UUID,
    "created_by" JSONB NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachments_storage_key_key" UNIQUE ("storage_key")
);

-- CreateIndex
CREATE INDEX "opportunities_workspace_id_deleted_at_idx" ON "opportunities"("workspace_id", "deleted_at");
CREATE INDEX "opportunities_workspace_id_owner_id_idx" ON "opportunities"("workspace_id", "owner_id");
CREATE INDEX "opportunities_workspace_id_company_id_idx" ON "opportunities"("workspace_id", "company_id");
CREATE INDEX "opportunities_workspace_id_point_of_contact_id_idx" ON "opportunities"("workspace_id", "point_of_contact_id");
CREATE INDEX "opportunities_search_idx" ON "opportunities" USING GIN ("search");

CREATE INDEX "notes_workspace_id_deleted_at_idx" ON "notes"("workspace_id", "deleted_at");
CREATE INDEX "notes_search_idx" ON "notes" USING GIN ("search");
CREATE UNIQUE INDEX "note_targets_note_id_target_type_target_id_key" ON "note_targets"("note_id", "target_type", "target_id");
CREATE INDEX "note_targets_workspace_id_target_type_target_id_idx" ON "note_targets"("workspace_id", "target_type", "target_id");

CREATE INDEX "tasks_workspace_id_deleted_at_idx" ON "tasks"("workspace_id", "deleted_at");
CREATE INDEX "tasks_workspace_id_assignee_id_idx" ON "tasks"("workspace_id", "assignee_id");
CREATE INDEX "tasks_workspace_id_status_idx" ON "tasks"("workspace_id", "status");
CREATE INDEX "tasks_search_idx" ON "tasks" USING GIN ("search");
CREATE UNIQUE INDEX "task_targets_task_id_target_type_target_id_key" ON "task_targets"("task_id", "target_type", "target_id");
CREATE INDEX "task_targets_workspace_id_target_type_target_id_idx" ON "task_targets"("workspace_id", "target_type", "target_id");

CREATE INDEX "attachments_workspace_id_target_type_target_id_idx" ON "attachments"("workspace_id", "target_type", "target_id");
CREATE INDEX "attachments_workspace_id_deleted_at_idx" ON "attachments"("workspace_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_point_of_contact_id_fkey" FOREIGN KEY ("point_of_contact_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "note_targets" ADD CONSTRAINT "note_targets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "note_targets" ADD CONSTRAINT "note_targets_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_targets" ADD CONSTRAINT "task_targets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_targets" ADD CONSTRAINT "task_targets_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security, in P0-2's shape. `opportunities` is owner-bearing and gets P1-1a's
-- restrictive owner policy as well; notes, tasks and attachments carry no owner — who may see
-- them follows from their targets, which the service checks and whose own policies apply to
-- the lookups it makes.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunities" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "opportunities"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
CREATE POLICY owner_scope ON "opportunities"
    AS RESTRICTIVE FOR ALL TO bylinecrm_app
    USING (app_owner_member_id() IS NULL OR owner_id = app_owner_member_id())
    WITH CHECK (app_owner_member_id() IS NULL OR owner_id = app_owner_member_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "opportunities" TO bylinecrm_app;

ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "notes"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "notes" TO bylinecrm_app;

ALTER TABLE "note_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_targets" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "note_targets"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "note_targets" TO bylinecrm_app;

ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "tasks"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO bylinecrm_app;

ALTER TABLE "task_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_targets" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "task_targets"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "task_targets" TO bylinecrm_app;

ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "attachments"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "attachments" TO bylinecrm_app;
