-- TRANS-1: when the recipient's server accepted a send, as SMTP2Go's `delivered` webhook event reports it.
-- Additive and nullable: nothing is backfilled (a send already gone simply has no delivery report).
ALTER TABLE "mail_outbound" ADD COLUMN "delivered_at" TIMESTAMPTZ;
