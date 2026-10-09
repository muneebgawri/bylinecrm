-- P1-4: saved views (PAR-056). A tenant table under row-level security in P0-2's shape. It
-- carries no record owner: who may see a view is decided by the service from `is_shared` and
-- `owner_member_id` (a member sees shared views and their own), not by the owner-scope policy,
-- which is about records. Note that `saved_views` therefore has no restrictive policy, and the
-- schema-invariant test accepts that because `owner_member_id` is not an `owner_id`.

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "object" "record_object" NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "owner_member_id" UUID,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    -- FilterGroup from @bylinecrm/shared, or NULL for "everything".
    "filter" JSONB,
    "sorts" JSONB NOT NULL DEFAULT '[]',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "group_by" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from clock_timestamp()),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_views_workspace_id_object_idx" ON "saved_views"("workspace_id", "object");
CREATE INDEX "saved_views_workspace_id_owner_member_id_idx" ON "saved_views"("workspace_id", "owner_member_id");

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_member_id_fkey" FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, in P0-2's shape.
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_views" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "saved_views"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_views" TO bylinecrm_app;
