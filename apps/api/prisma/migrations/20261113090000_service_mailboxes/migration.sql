-- SVC-1: a service inbox — a shared address (media@, pr@) synced so an integration can read what partners send it.
-- Mail only and read only: no calendar sync, no sending, its mail on no record, outside the guardrails. The purpose is
-- fixed when the mailbox connects, as the others' are; the existing checks (pool-only SMTP2Go, pool-only booking link)
-- already keep a service inbox on Gmail with no booking link.
ALTER TYPE "mailbox_purpose" ADD VALUE IF NOT EXISTS 'service';
