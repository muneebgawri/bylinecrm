-- P2-3a (#87): Gmail replaces the Message-ID a sender sets with its own (seen against real Gmail on
-- 2026-10-11). A send keeps ours in `rfc822_message_id` and now also records Gmail's, once known, so
-- replies are matched against both from one row.
ALTER TABLE "mail_outbound" ADD COLUMN "provider_rfc822_message_id" TEXT;

CREATE INDEX "mail_outbound_provider_rfc822_message_id_idx" ON "mail_outbound"("provider_rfc822_message_id");
