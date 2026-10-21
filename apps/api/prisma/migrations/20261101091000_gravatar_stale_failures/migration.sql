-- Gravatar "failures" recorded before the guarded lookup answered Node's `all: true` connect (fixed 2026-10-14):
-- every connection failed with ERR_INVALID_IP_ADDRESS, which said nothing about the person's picture. They are
-- dropped so the person page stops showing them; the next run (or "Enrich now") asks Gravatar again.
DELETE FROM "enrichment_answers"
WHERE "source" = 'gravatar' AND "status" = 'failed' AND "note" LIKE '%ERR_INVALID_IP_ADDRESS%';
