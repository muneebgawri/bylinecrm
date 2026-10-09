-- P2-4: email templates and the workspace's mail settings (doc 48 FR-CRMS-3, FR-CRMS-7,
-- FR-CRMS-12; doc 50 §C). Two tenant tables under row-level security in P0-2's shape. The app
-- role may read, insert and update both; it may not delete either — a template is retired by
-- `deleted_at`, and a workspace's settings row lives as long as the workspace.

-- CreateEnum
CREATE TYPE "template_kind" AS ENUM ('personal', 'outreach');

-- CreateTable
CREATE TABLE "email_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "template_kind" NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "body" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" JSONB NOT NULL,
    "updated_by" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_mail_settings" (
    "workspace_id" UUID NOT NULL,
    "postal_address" JSONB,
    "default_sender_name" TEXT,
    "unsubscribe_footer_text" TEXT NOT NULL,
    "updated_by" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workspace_mail_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE INDEX "email_templates_workspace_id_deleted_at_updated_at_idx" ON "email_templates"("workspace_id", "deleted_at", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_mail_settings" ADD CONSTRAINT "workspace_mail_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A template is optimistically versioned from 1; the body is a rich-text document.
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_version_positive" CHECK ("version" >= 1);
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_body_is_doc" CHECK ("body" ->> 'type' = 'doc');

-- Row-level security in P0-2's shape; no DELETE for the app role on either table.
ALTER TABLE "email_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "email_templates"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "email_templates" TO bylinecrm_app;

ALTER TABLE "workspace_mail_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_mail_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "workspace_mail_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "workspace_mail_settings" TO bylinecrm_app;
