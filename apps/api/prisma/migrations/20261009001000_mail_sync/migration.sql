-- P2-2: mail a connected Gmail mailbox holds (doc 48 FR-CRMS-2, §6; doc 50 §A). Threads, messages
-- and their participants, matched to the people and members of the workspace; the per-mailbox sync
-- cursor; and the blocklist. Five tenant tables under row-level security in P0-2's shape. A synced
-- message is never edited or deleted by the app role; a participant's match is re-pointed when a
-- person gains, loses or deletes an address. `linked_object` gains `email`: a message leaves a
-- `linked-email.*` timeline entry on every record it concerns.

-- CreateEnum
CREATE TYPE "mail_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "mail_participant_role" AS ENUM ('from', 'to', 'cc', 'bcc');

-- CreateEnum
CREATE TYPE "mail_sync_status" AS ENUM ('idle', 'syncing', 'failed');

-- AlterEnum
ALTER TYPE "linked_object" ADD VALUE 'email';

-- CreateTable
CREATE TABLE "mail_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "provider_thread_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "last_message_at" TIMESTAMPTZ NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mail_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "rfc822_message_id" TEXT,
    "in_reply_to" TEXT,
    "references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "direction" "mail_direction" NOT NULL,
    "from_address" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "snippet" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "body_text" TEXT NOT NULL DEFAULT '',
    "body_html_sanitized" TEXT,
    "body_truncated" BOOLEAN NOT NULL DEFAULT false,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "label_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mail_messages_from_lower" CHECK ("from_address" = lower("from_address"))
);

-- CreateTable
CREATE TABLE "mail_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "role" "mail_participant_role" NOT NULL,
    "address" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT '',
    "person_id" UUID,
    "member_id" UUID,

    CONSTRAINT "mail_participants_pkey" PRIMARY KEY ("id"),
    -- One spelling per address, so matching and the address index mean what they say.
    CONSTRAINT "mail_participants_address_lower" CHECK ("address" = lower("address"))
);

-- CreateTable
CREATE TABLE "mailbox_sync_states" (
    "mailbox_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "history_id" TEXT,
    "status" "mail_sync_status" NOT NULL DEFAULT 'idle',
    "last_synced_at" TIMESTAMPTZ,
    "last_error" JSONB,
    "full_sync_completed_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,
    -- A completed first import always leaves a cursor to continue from.
    CONSTRAINT "mailbox_sync_states_cursor_after_import" CHECK ("full_sync_completed_at" IS NULL OR "history_id" IS NOT NULL),

    CONSTRAINT "mailbox_sync_states_pkey" PRIMARY KEY ("mailbox_id")
);

-- CreateTable
CREATE TABLE "blocklist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "member_id" UUID,
    "value" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocklist_entries_pkey" PRIMARY KEY ("id"),
    -- `someone@example.com` or `@example.com`, lower case (normaliseBlocklistValue in @bylinecrm/shared).
    CONSTRAINT "blocklist_entries_value_shape" CHECK (
        "value" = lower("value") AND char_length("value") <= 254
        AND "value" ~ '^([^[:space:]@]+)?@[a-z0-9-]+(\.[a-z0-9-]+)+$'
    )
);

-- CreateIndex
CREATE INDEX "mail_threads_workspace_id_last_message_at_idx" ON "mail_threads"("workspace_id", "last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mail_threads_mailbox_id_provider_thread_id_key" ON "mail_threads"("mailbox_id", "provider_thread_id");

-- CreateIndex
CREATE INDEX "mail_messages_workspace_id_thread_id_sent_at_idx" ON "mail_messages"("workspace_id", "thread_id", "sent_at");

-- CreateIndex
CREATE INDEX "mail_messages_workspace_id_rfc822_message_id_idx" ON "mail_messages"("workspace_id", "rfc822_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_mailbox_id_provider_message_id_key" ON "mail_messages"("mailbox_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "mail_participants_workspace_id_address_idx" ON "mail_participants"("workspace_id", "address");

-- CreateIndex
CREATE INDEX "mail_participants_workspace_id_person_id_idx" ON "mail_participants"("workspace_id", "person_id");

-- CreateIndex
CREATE INDEX "mail_participants_message_id_idx" ON "mail_participants"("message_id");

-- CreateIndex
CREATE INDEX "mailbox_sync_states_workspace_id_idx" ON "mailbox_sync_states"("workspace_id");

-- CreateIndex
CREATE INDEX "blocklist_entries_workspace_id_member_id_idx" ON "blocklist_entries"("workspace_id", "member_id");

-- AddForeignKey
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_participants" ADD CONSTRAINT "mail_participants_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_sync_states" ADD CONSTRAINT "mailbox_sync_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_sync_states" ADD CONSTRAINT "mailbox_sync_states_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One spelling of an entry per scope: once for the workspace, once per member.
CREATE UNIQUE INDEX "blocklist_entries_workspace_value_key" ON "blocklist_entries"("workspace_id", "value") WHERE "member_id" IS NULL;
CREATE UNIQUE INDEX "blocklist_entries_member_value_key" ON "blocklist_entries"("workspace_id", "member_id", "value") WHERE "member_id" IS NOT NULL;

-- Row-level security in P0-2's shape.
ALTER TABLE "mail_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_threads" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_threads"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- No DELETE: a thread stays with its mailbox's history.
GRANT SELECT, INSERT, UPDATE ON "mail_threads" TO bylinecrm_app;

ALTER TABLE "mail_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_messages"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- Insert-only: a synced message is what the mailbox held; nothing edits or removes it.
GRANT SELECT, INSERT ON "mail_messages" TO bylinecrm_app;

ALTER TABLE "mail_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_participants"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- UPDATE re-points a participant's person when addresses change; no DELETE.
GRANT SELECT, INSERT, UPDATE ON "mail_participants" TO bylinecrm_app;

ALTER TABLE "mailbox_sync_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailbox_sync_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mailbox_sync_states"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "mailbox_sync_states" TO bylinecrm_app;

ALTER TABLE "blocklist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blocklist_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "blocklist_entries"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- An entry is added or removed, never edited.
GRANT SELECT, INSERT, DELETE ON "blocklist_entries" TO bylinecrm_app;
