-- #193: email signatures. A signature belongs to a mailbox (its own, or the workspace default unless switched
-- off); a pool mailbox may link to a booking page an admin picks. A member's job title, phone and Slotline
-- username are what `{{sender.*}}` reads. The workspace logo is served publicly by an unguessable token; a
-- replaced one keeps answering for a grace period.

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "booking_link" TEXT,
ADD COLUMN     "signature" JSONB,
ADD COLUMN     "use_default_signature" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "job_title" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "slotline_username" TEXT;

-- CreateTable
CREATE TABLE "workspace_signature_settings" (
    "workspace_id" UUID NOT NULL,
    "default_signature" JSONB,
    "lock_logo" BOOLEAN NOT NULL DEFAULT false,
    "lock_booking_link" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workspace_signature_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "workspace_logos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_id" UUID,
    "retired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_logos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_logos_token_key" ON "workspace_logos"("token");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_logos_storage_key_key" ON "workspace_logos"("storage_key");

-- CreateIndex
CREATE INDEX "workspace_logos_workspace_id_retired_at_idx" ON "workspace_logos"("workspace_id", "retired_at");

-- AddForeignKey
ALTER TABLE "workspace_signature_settings" ADD CONSTRAINT "workspace_signature_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_logos" ADD CONSTRAINT "workspace_logos_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_logos" ADD CONSTRAINT "workspace_logos_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One current logo per workspace; a Slotline username is a path segment, never a path; a pool's booking link is https.
CREATE UNIQUE INDEX "workspace_logos_current_key" ON "workspace_logos"("workspace_id") WHERE "retired_at" IS NULL;
ALTER TABLE "workspace_logos" ADD CONSTRAINT "workspace_logos_shape"
    CHECK ("width" > 0 AND "height" > 0 AND "size_bytes" > 0);
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_slotline_username_shape"
    CHECK ("slotline_username" IS NULL OR "slotline_username" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_booking_link_shape"
    CHECK ("booking_link" IS NULL OR ("purpose" = 'pool' AND "booking_link" ~ '^https://'));

-- Row-level security in P0-2's shape. The public logo route finds a logo by its token through the owner client
-- (as the unsubscribe and tracking routes do).
ALTER TABLE "workspace_signature_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_signature_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "workspace_signature_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_signature_settings" TO bylinecrm_app;

ALTER TABLE "workspace_logos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_logos" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "workspace_logos"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_logos" TO bylinecrm_app;
