-- #134: a failed send can be sent again from the server, rebuilt from what was asked (`request`).
-- `request` is now kept for every send until it is final, and wiped once the send is sent or
-- cancelled; rows already final lose theirs here. `retried_at` records a retry by hand.
ALTER TABLE "mail_outbound" ADD COLUMN "retried_at" TIMESTAMPTZ;
UPDATE "mail_outbound" SET "request" = NULL WHERE "status" IN ('sent', 'cancelled') AND "request" IS NOT NULL;
