-- TRANS-1 (#209): SMTP2Go as a second transport for the outreach pool. A pool mailbox sends through its Gmail
-- grant or through SMTP2Go's HTTP API with a sealed API key; SMTP2Go's webhook (a bearer secret per mailbox)
-- reports bounces, complaints, opens and clicks into the tables the Gmail path writes. Never a personal mailbox.
-- Contract: docs/design-notes/TRANS-1.md.

-- CreateEnum
CREATE TYPE "mailbox_transport" AS ENUM ('gmail', 'smtp2go');

-- AlterTable
ALTER TABLE "mailboxes"
    ADD COLUMN "transport" "mailbox_transport" NOT NULL DEFAULT 'gmail',
    ADD COLUMN "transport_key_ciphertext" TEXT,
    ADD COLUMN "hook_secret_ciphertext" TEXT,
    ADD COLUMN "last_hook_at" TIMESTAMPTZ,
    ADD COLUMN "last_hook_result" TEXT;

-- Only a pool mailbox sends through SMTP2Go: 1:1 and personal mail stay on the member's own Gmail.
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_smtp2go_pool_only" CHECK ("transport" = 'gmail' OR "purpose" = 'pool');

-- What a mailbox holds by transport: a Gmail mailbox its refresh token (as before), an SMTP2Go one its API key and
-- hook secret and never a Google token; a disconnected mailbox holds no secret at all.
ALTER TABLE "mailboxes" DROP CONSTRAINT "mailboxes_refresh_token_by_status";
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_credentials_by_status" CHECK (
    ("status" = 'disconnected' AND "refresh_token_ciphertext" IS NULL AND "access_token_ciphertext" IS NULL
        AND "transport_key_ciphertext" IS NULL)
    OR ("status" <> 'disconnected' AND "transport" = 'gmail' AND "refresh_token_ciphertext" IS NOT NULL
        AND "transport_key_ciphertext" IS NULL)
    OR ("status" <> 'disconnected' AND "transport" = 'smtp2go' AND "refresh_token_ciphertext" IS NULL
        AND "access_token_ciphertext" IS NULL AND "transport_key_ciphertext" IS NOT NULL
        AND "hook_secret_ciphertext" IS NOT NULL)
);

-- A bounce SMTP2Go reported has no stored report message; it carries SMTP2Go's event key instead.
ALTER TABLE "mail_bounces" ALTER COLUMN "message_id" DROP NOT NULL;
ALTER TABLE "mail_bounces" ADD COLUMN "provider_event_id" TEXT;
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_report_or_event" CHECK (
    ("message_id" IS NOT NULL) <> ("provider_event_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "mail_bounces_mailbox_id_provider_event_id_key" ON "mail_bounces"("mailbox_id", "provider_event_id");

-- An open or click SMTP2Go reported has no token of ours; it carries SMTP2Go's event key and, for a click, the link.
ALTER TABLE "tracking_hits" ALTER COLUMN "token_id" DROP NOT NULL;
ALTER TABLE "tracking_hits" ADD COLUMN "provider_event_id" TEXT;
ALTER TABLE "tracking_hits" ADD COLUMN "url" TEXT;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_token_or_event" CHECK (
    ("token_id" IS NOT NULL) <> ("provider_event_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "tracking_hits_provider_event_id_key" ON "tracking_hits"("provider_event_id");
