-- Composer drafts: the message a member is writing on a record, saved as they go and on leaving the composer,
-- private to them. A new table only — nothing existing is a draft, so there is nothing to backfill.

-- CreateTable
CREATE TABLE "mail_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "author_member_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "deal_id" UUID,
    "content" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mail_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mail_drafts_workspace_id_author_member_id_person_id_idx" ON "mail_drafts"("workspace_id", "author_member_id", "person_id");

-- CreateIndex
CREATE INDEX "mail_drafts_deal_id_idx" ON "mail_drafts"("deal_id");

-- One draft per author in one composer: the person's, or the person's on a deal. NULLS NOT DISTINCT so the
-- person's own (no deal) is one too.
CREATE UNIQUE INDEX "mail_drafts_context_key" ON "mail_drafts"("workspace_id", "author_member_id", "person_id", "deal_id") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_author_member_id_fkey" FOREIGN KEY ("author_member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_version_positive" CHECK ("version" >= 1);

-- Row-level security in P0-2's shape: the workspace's rows only. A draft is its author's alone — every read and
-- write is also by `author_member_id` (the service's check; the app role has no member setting to bind to).
ALTER TABLE "mail_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_drafts"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_drafts" TO bylinecrm_app;
