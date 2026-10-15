-- CAL-2: Slotline bookings (owner request 2026-10-15). The workspace's own booking site (a Cal.com community
-- fork) delivers its bookings as a signed webhook; each becomes the organiser's copy of the meeting in the
-- CAL-1 store — one meeting with the Google Calendar event Slotline writes for it, since both carry the
-- booking's iCalendar UID. A copy now has a source; a Slotline copy has no mailbox. The workspace's settings
-- hold the hook's token (hashed) and the signing secret (encrypted).

-- CreateEnum
CREATE TYPE "meeting_source" AS ENUM ('google_calendar', 'slotline');

-- AlterTable
ALTER TABLE "calendar_event_copies" ADD COLUMN     "source" "meeting_source" NOT NULL DEFAULT 'google_calendar',
ALTER COLUMN "mailbox_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN     "booked_via" "meeting_source" NOT NULL DEFAULT 'google_calendar',
ADD COLUMN     "slotline_uid" TEXT;

-- CreateTable
CREATE TABLE "slotline_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "base_url" TEXT NOT NULL,
    "hook_token_hash" TEXT NOT NULL,
    "hook_token_ciphertext" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "configured_by_id" UUID NOT NULL,
    "last_delivery_at" TIMESTAMPTZ,
    "last_delivery_result" TEXT,
    "unmatched_organizers" INTEGER NOT NULL DEFAULT 0,
    "last_unmatched_organizer" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "slotline_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slotline_settings_workspace_id_key" ON "slotline_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "slotline_settings_hook_token_hash_key" ON "slotline_settings"("hook_token_hash");

-- AddForeignKey
ALTER TABLE "slotline_settings" ADD CONSTRAINT "slotline_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slotline_settings" ADD CONSTRAINT "slotline_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A Google copy is read through a mailbox; a Slotline copy never is. One Slotline copy per booking per workspace.
ALTER TABLE "calendar_event_copies" ADD CONSTRAINT "calendar_event_copies_source_mailbox"
    CHECK (("source" = 'google_calendar') = ("mailbox_id" IS NOT NULL));
CREATE UNIQUE INDEX "calendar_event_copies_slotline_key" ON "calendar_event_copies"("workspace_id", "provider_event_id")
    WHERE "source" = 'slotline';

-- A booking-site address is an https origin; the counter never goes below zero.
ALTER TABLE "slotline_settings" ADD CONSTRAINT "slotline_settings_shape"
    CHECK ("base_url" ~ '^https://[^/?#]+$' AND "unmatched_organizers" >= 0);

-- Row-level security in P0-2's shape. The public hook finds its workspace by the token through the owner
-- client (as the tracking routes do); everything after that runs under the workspace's policy.
ALTER TABLE "slotline_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slotline_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "slotline_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "slotline_settings" TO bylinecrm_app;
