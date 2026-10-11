-- P2-3: mail the CRM sends. One table, `mail_outbound`: the message as built (its MIME is exactly
-- what goes to Gmail), where its send stands, and — once sent — Gmail's ids and the stored copy sync's
-- writer made of it (`mail_message_id`). Reply detection reads it; nothing deletes from it.

-- CreateEnum
CREATE TYPE "mail_outbound_status" AS ENUM ('queued', 'sending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "mail_outbound" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "sender_member_id" UUID NOT NULL,
    "person_id" UUID,
    "deal_id" UUID,
    "template_id" UUID,
    "reply_to_message_id" UUID,
    "status" "mail_outbound_status" NOT NULL DEFAULT 'queued',
    "rfc822_message_id" TEXT NOT NULL,
    "to_addresses" TEXT[],
    "cc_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bcc_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "provider_thread_id" TEXT,
    "mail_message_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ,
    "last_error" JSONB,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mail_outbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_outbound_rfc822_message_id_key" ON "mail_outbound"("rfc822_message_id");

-- CreateIndex
CREATE INDEX "mail_outbound_workspace_id_sender_member_id_created_at_idx" ON "mail_outbound"("workspace_id", "sender_member_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mail_outbound_mailbox_id_provider_thread_id_idx" ON "mail_outbound"("mailbox_id", "provider_thread_id");

-- CreateIndex
CREATE INDEX "mail_outbound_workspace_id_mail_message_id_idx" ON "mail_outbound"("workspace_id", "mail_message_id");

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_sender_member_id_fkey" FOREIGN KEY ("sender_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "mail_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_mail_message_id_fkey" FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- What the columns promise, beyond their types: a message has someone to go to; a sent one has
-- Gmail's id and a time; addresses are stored lower case.
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_has_recipient"
    CHECK ("to_addresses" IS NOT NULL AND cardinality("to_addresses") >= 1);
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_sent_has_ids"
    CHECK ("status" <> 'sent' OR ("provider_message_id" IS NOT NULL AND "sent_at" IS NOT NULL));
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_addresses_lower"
    CHECK (
        "to_addresses"::text = lower("to_addresses"::text)
        AND coalesce("cc_addresses"::text, '') = lower(coalesce("cc_addresses"::text, ''))
        AND coalesce("bcc_addresses"::text, '') = lower(coalesce("bcc_addresses"::text, ''))
    );

-- Row-level security in P0-2's shape.
ALTER TABLE "mail_outbound" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_outbound" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_outbound"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- UPDATE records the send's progress; no DELETE: what was sent stays on record.
GRANT SELECT, INSERT, UPDATE ON "mail_outbound" TO bylinecrm_app;
