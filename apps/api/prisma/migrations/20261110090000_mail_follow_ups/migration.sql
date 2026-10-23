-- Queued follow-ups: a 1:1 send may follow an earlier one in the same thread (`follows_outbound_id`), sent as a
-- reply to it once it has gone. A nullable column, its index and its foreign key only — every existing send
-- follows nothing, which is what NULL says: nothing to backfill.

-- AlterTable
ALTER TABLE "mail_outbound" ADD COLUMN "follows_outbound_id" UUID;

-- CreateIndex
CREATE INDEX "mail_outbound_follows_outbound_id_idx" ON "mail_outbound"("follows_outbound_id");

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_follows_outbound_id_fkey" FOREIGN KEY ("follows_outbound_id") REFERENCES "mail_outbound"("id") ON DELETE SET NULL ON UPDATE CASCADE;
