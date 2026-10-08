-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security (P0-2). One definition of "the current workspace" for every
-- policy: app_workspace_id(). Unset (or empty) means NULL, and NULL matches no row —
-- a request that forgot to scope itself sees nothing, never everything.
-- The role name must equal APP_DB_ROLE in packages/shared (a spec keeps them in step).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION app_workspace_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    RETURN NULLIF(current_setting('app.workspace_id', true), '')::uuid;

-- The app role: no privilege it was not granted here. PUBLIC keeps nothing on the schema.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bylinecrm_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bylinecrm_app;
-- _prisma_migrations stays unreadable: the app role never learns the schema's history.

-- Tenant table: workspace_members.
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "workspace_members"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_members" TO bylinecrm_app;

-- Global tables, read-only to the app role and scoped to the current workspace:
-- a workspace sees itself; a user is visible when they are a member of the current workspace.
-- P0-3 adds an `app.user_id` setting and a policy letting a signed-in user list their own
-- memberships before a workspace is chosen; creation of users and workspaces stays an owner
-- operation until P0-3 decides otherwise.
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY current_workspace ON "workspaces"
    FOR SELECT TO bylinecrm_app
    USING (id = app_workspace_id());
GRANT SELECT ON "workspaces" TO bylinecrm_app;

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY members_of_current_workspace ON "users"
    FOR SELECT TO bylinecrm_app
    USING (EXISTS (
        SELECT 1 FROM "workspace_members" m
        WHERE m.user_id = "users".id AND m.workspace_id = app_workspace_id()
    ));
GRANT SELECT ON "users" TO bylinecrm_app;
