-- Members hear of replies to, clicks in and opens of the emails they sent from the CRM: three notification kinds,
-- two nullable target columns and three settings with a constant default. Expand only (no rewrite, no backfill),
-- so the colour still serving keeps working against this schema.

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'email_replied';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'email_clicked';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'email_opened';

-- A click or an open is about the send (once per send); a reply is about the inbound message (once per reply).
ALTER TABLE "notifications" ADD COLUMN "mail_outbound_id" UUID;
ALTER TABLE "notifications" ADD COLUMN "mail_message_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_mail_outbound_id_fkey"
    FOREIGN KEY ("mail_outbound_id") REFERENCES "mail_outbound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_mail_message_id_fkey"
    FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "notifications_member_id_kind_mail_outbound_id_key"
    ON "notifications"("member_id", "kind", "mail_outbound_id");
CREATE UNIQUE INDEX "notifications_member_id_kind_mail_message_id_key"
    ON "notifications"("member_id", "kind", "mail_message_id");
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing"
    CHECK (num_nonnulls("task_id", "transfer_id", "guardrail_event_id", "invoice_id", "cadence_lapse_id",
                        "newswireos_payment_id", "mail_outbound_id", "mail_message_id") = 1);

-- Each member's say, on unless turned off.
ALTER TABLE "workspace_members" ADD COLUMN "notify_email_replies" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "workspace_members" ADD COLUMN "notify_email_clicks" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "workspace_members" ADD COLUMN "notify_email_opens" BOOLEAN NOT NULL DEFAULT true;
