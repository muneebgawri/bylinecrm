-- A sending domain's mailboxes may sign with more than one DKIM selector: Gmail with `google` (the
-- primary `dkim_selector`), an SMTP2Go pool mailbox (TRANS-1) with SMTP2Go's own. The check reads every
-- selector the domain's senders use. Additive, with a constant default: no row is rewritten here.
ALTER TABLE "sending_domains" ADD COLUMN "extra_dkim_selectors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
