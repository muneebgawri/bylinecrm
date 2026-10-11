-- P2-5: scheduled sends. A send can be accepted for later (`scheduled`, with `send_at`) and called off
-- before it goes (`cancelled`). What it was asked to be is kept (`request`), and the message is built
-- and checked again at `send_at` — so `mime` is empty until then. A send made at once is unchanged.

-- AlterEnum
ALTER TYPE "mail_outbound_status" ADD VALUE 'scheduled' BEFORE 'queued';
ALTER TYPE "mail_outbound_status" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "mail_outbound" ALTER COLUMN "mime" DROP NOT NULL,
ADD COLUMN     "send_at" TIMESTAMPTZ,
ADD COLUMN     "sender_time_zone" TEXT,
ADD COLUMN     "request" JSONB,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "mail_outbound_status_send_at_idx" ON "mail_outbound"("status", "send_at");

-- What the new columns promise. Compared as text so the checks do not depend on the enum values
-- added above being committed first.
-- A send on its way, or gone, has its message built. A scheduled one is built at its time; one that
-- was cancelled, or failed a check at its time, may never have been.
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_built_when_sending"
    CHECK ("status"::text NOT IN ('queued', 'sending', 'sent') OR "mime" IS NOT NULL);
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_scheduled_has_time_and_request"
    CHECK ("status"::text <> 'scheduled' OR ("send_at" IS NOT NULL AND "request" IS NOT NULL));
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_cancelled_has_time"
    CHECK ("status"::text <> 'cancelled' OR "cancelled_at" IS NOT NULL);
