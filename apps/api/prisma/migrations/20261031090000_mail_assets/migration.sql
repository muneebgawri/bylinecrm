-- Images uploaded for mail (a body's or a signature's), served publicly by an unguessable token.
CREATE TABLE "mail_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_assets_token_key" ON "mail_assets"("token");

-- CreateIndex
CREATE UNIQUE INDEX "mail_assets_storage_key_key" ON "mail_assets"("storage_key");

-- CreateIndex
CREATE INDEX "mail_assets_workspace_id_created_at_idx" ON "mail_assets"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "mail_assets" ADD CONSTRAINT "mail_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_assets" ADD CONSTRAINT "mail_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "mail_assets" ADD CONSTRAINT "mail_assets_shape"
    CHECK ("width" > 0 AND "height" > 0 AND "size_bytes" > 0 AND "content_type" IN ('image/png', 'image/jpeg'));

-- Row-level security in P0-2's shape. The public route finds an image by its token through the owner client
-- (as the logo, unsubscribe and tracking routes do).
ALTER TABLE "mail_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_assets" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_assets"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_assets" TO bylinecrm_app;
