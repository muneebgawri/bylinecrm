-- BYL-1 (#207): BylineAI lead webhook receiver. The workspace's link (signing secret, round-robin list) and the
-- leads taken in, keyed by BylineAI's lead_id so a redelivery is answered `duplicate`.

-- CreateTable
CREATE TABLE "byline_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "round_robin_member_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "round_robin_cursor" INTEGER NOT NULL DEFAULT 0,
    "configured_by_id" UUID NOT NULL,
    "last_delivery_at" TIMESTAMPTZ,
    "last_delivery_result" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "byline_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "byline_leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "lead_id" TEXT NOT NULL,
    "person_id" UUID,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "byline_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "byline_settings_workspace_id_key" ON "byline_settings"("workspace_id");
CREATE UNIQUE INDEX "byline_leads_workspace_id_lead_id_key" ON "byline_leads"("workspace_id", "lead_id");

-- Shape: a cursor that only counts up; a lead id with something in it.
ALTER TABLE "byline_settings" ADD CONSTRAINT "byline_settings_shape" CHECK ("round_robin_cursor" >= 0);
ALTER TABLE "byline_leads" ADD CONSTRAINT "byline_leads_shape" CHECK (length(btrim("lead_id")) > 0);

-- AddForeignKey
ALTER TABLE "byline_settings" ADD CONSTRAINT "byline_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "byline_settings" ADD CONSTRAINT "byline_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "byline_leads" ADD CONSTRAINT "byline_leads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "byline_leads" ADD CONSTRAINT "byline_leads_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security in P0-2's shape. The receiver is public: the path names the workspace, the owner client reads
-- only that workspace's secret, and everything after the signature is checked runs under the workspace's policy.
ALTER TABLE "byline_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "byline_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "byline_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "byline_settings" TO bylinecrm_app;

ALTER TABLE "byline_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "byline_leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "byline_leads"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "byline_leads" TO bylinecrm_app;
