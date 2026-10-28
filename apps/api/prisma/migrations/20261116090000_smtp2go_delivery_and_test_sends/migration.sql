-- TRANS-1: when the recipient's server accepted a send, as SMTP2Go's `delivered` webhook event reports it.
-- Additive and nullable: nothing is backfilled (a send already gone simply has no delivery report).
ALTER TABLE "mail_outbound" ADD COLUMN "delivered_at" TIMESTAMPTZ;

-- TRANS-1: an admin's "Send test" through an SMTP2Go pool mailbox. A constant default is stored in the catalogue
-- (no table rewrite, no backfill): every existing send is not a test.
ALTER TABLE "mail_outbound" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;

-- TRANS-1: a pool mailbox paused because SMTP2Go rejected its last sends for a reason on our side.
ALTER TYPE "guardrail_kind" ADD VALUE IF NOT EXISTS 'rejected_sends';
