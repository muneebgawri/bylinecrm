-- Slotline never retries a webhook delivery that failed, so bookings made while the CRM was down were lost. A
-- workspace that gives the key of Slotline's admin route has its booking changes read again periodically,
-- through the same ingest as the hook. Columns only; nothing is backfilled.
ALTER TABLE "slotline_settings" ADD COLUMN "catch_up_key_ciphertext" TEXT,
ADD COLUMN "catch_up_through" TIMESTAMPTZ,
ADD COLUMN "last_catch_up_at" TIMESTAMPTZ,
ADD COLUMN "last_catch_up_result" TEXT;
