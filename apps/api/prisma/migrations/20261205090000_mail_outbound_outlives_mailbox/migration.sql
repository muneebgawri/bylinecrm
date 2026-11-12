-- A send outlives the mailbox it went from (#385). `mail_outbound` is the record of what the CRM sent — nothing
-- deletes from it — so removing a mailbox cannot take its sends with it: the send keeps everything else (sender,
-- person, deal, the stored message, its tracking) and its mailbox becomes unknown. Schema only.
ALTER TABLE "mail_outbound" ALTER COLUMN "mailbox_id" DROP NOT NULL;
ALTER TABLE "mail_outbound" DROP CONSTRAINT "mail_outbound_mailbox_id_fkey";
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Removing a mailbox is the one reason its row goes, and its Google calendar copies with it (a copy is a mailbox's:
-- the database requires one for a Google copy, so none can outlive it). The events the copies were of stay: a
-- meeting that happened is still on the people it was with. The application may now delete both.
GRANT DELETE ON "mailboxes" TO bylinecrm_app;
GRANT DELETE ON "calendar_event_copies" TO bylinecrm_app;
