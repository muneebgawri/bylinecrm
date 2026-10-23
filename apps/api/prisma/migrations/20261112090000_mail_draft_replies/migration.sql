-- Drafts of replies: a draft may belong to a reply in a thread, keyed by the message it answers. A nullable column,
-- its index and foreign key, and the one-draft-per-composer key widened to it — every existing draft is a new
-- email's, which is what NULL says: nothing to backfill.

-- AlterTable
ALTER TABLE "mail_drafts" ADD COLUMN "reply_to_message_id" UUID;

-- CreateIndex
CREATE INDEX "mail_drafts_reply_to_message_id_idx" ON "mail_drafts"("reply_to_message_id");

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One draft per author in one composer: a person's record composer (and deal's), or a reply to one message.
DROP INDEX "mail_drafts_context_key";
CREATE UNIQUE INDEX "mail_drafts_context_key" ON "mail_drafts"("workspace_id", "author_member_id", "person_id", "deal_id", "reply_to_message_id") NULLS NOT DISTINCT;
