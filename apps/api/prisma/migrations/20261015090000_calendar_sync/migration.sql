-- CAL-1: calendar sync (owner request 2026-10-15). Meetings with people outside the workspace, read from
-- each member's Google Calendar through their personal mailbox's connection: the meeting once per
-- workspace, each member's calendar's copy of it, its attendees matched to people and members, and the
-- per-mailbox sync state. Four tenant tables under row-level security in P0-2's shape. `linked_object`
-- gains `meeting`: a meeting leaves a `linked-meeting.*` timeline entry on every record it concerns.

-- CreateEnum
CREATE TYPE "calendar_event_status" AS ENUM ('confirmed', 'tentative', 'cancelled');

-- CreateEnum
CREATE TYPE "calendar_response_status" AS ENUM ('needs_action', 'accepted', 'tentative', 'declined');

-- AlterEnum
ALTER TYPE "linked_object" ADD VALUE 'meeting';

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "identity_key" TEXT NOT NULL,
    "ical_uid" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "location" TEXT,
    "conference_url" TEXT,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "status" "calendar_event_status" NOT NULL,
    "organizer_address" TEXT,
    "host_member_id" UUID NOT NULL,
    "booked_at" TIMESTAMPTZ NOT NULL,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_copies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "response_status" "calendar_response_status" NOT NULL,
    "is_organizer" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "calendar_event_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT '',
    "response_status" "calendar_response_status" NOT NULL,
    "is_organizer" BOOLEAN NOT NULL DEFAULT false,
    "person_id" UUID,
    "member_id" UUID,
    "lead_created_for_member_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_sync_states" (
    "mailbox_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "status" "mail_sync_status" NOT NULL DEFAULT 'idle',
    "last_synced_at" TIMESTAMPTZ,
    "window_read_at" TIMESTAMPTZ,
    "last_error" JSONB,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "calendar_sync_states_pkey" PRIMARY KEY ("mailbox_id")
);

-- CreateIndex
CREATE INDEX "calendar_events_workspace_id_starts_at_idx" ON "calendar_events"("workspace_id", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_events_workspace_id_host_member_id_booked_at_idx" ON "calendar_events"("workspace_id", "host_member_id", "booked_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_workspace_id_identity_key_key" ON "calendar_events"("workspace_id", "identity_key");

-- CreateIndex
CREATE INDEX "calendar_event_copies_event_id_idx" ON "calendar_event_copies"("event_id");

-- CreateIndex
CREATE INDEX "calendar_event_copies_workspace_id_member_id_idx" ON "calendar_event_copies"("workspace_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_copies_mailbox_id_provider_event_id_key" ON "calendar_event_copies"("mailbox_id", "provider_event_id");

-- CreateIndex
CREATE INDEX "calendar_event_participants_workspace_id_address_idx" ON "calendar_event_participants"("workspace_id", "address");

-- CreateIndex
CREATE INDEX "calendar_event_participants_workspace_id_person_id_idx" ON "calendar_event_participants"("workspace_id", "person_id");

-- CreateIndex
CREATE INDEX "calendar_event_participants_workspace_id_lead_created_for_m_idx" ON "calendar_event_participants"("workspace_id", "lead_created_for_member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_participants_event_id_address_key" ON "calendar_event_participants"("event_id", "address");

-- CreateIndex
CREATE INDEX "calendar_sync_states_workspace_id_idx" ON "calendar_sync_states"("workspace_id");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_host_member_id_fkey" FOREIGN KEY ("host_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_copies" ADD CONSTRAINT "calendar_event_copies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_copies" ADD CONSTRAINT "calendar_event_copies_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_copies" ADD CONSTRAINT "calendar_event_copies_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_copies" ADD CONSTRAINT "calendar_event_copies_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_lead_created_for_member_id_fkey" FOREIGN KEY ("lead_created_for_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_sync_states" ADD CONSTRAINT "calendar_sync_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_sync_states" ADD CONSTRAINT "calendar_sync_states_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- What the schema cannot say: one spelling per address, and a meeting that ends no earlier than it starts.
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_shape"
    CHECK ("ends_at" >= "starts_at" AND ("organizer_address" IS NULL OR "organizer_address" = lower("organizer_address")));
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_address_lower"
    CHECK ("address" = lower("address"));

-- Row-level security in P0-2's shape.
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "calendar_events"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- No DELETE: a cancelled meeting stays, marked cancelled, so a KPI period reads the same later.
GRANT SELECT, INSERT, UPDATE ON "calendar_events" TO bylinecrm_app;

ALTER TABLE "calendar_event_copies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_event_copies" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "calendar_event_copies"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- UPDATE follows the member's answer as it changes; no DELETE.
GRANT SELECT, INSERT, UPDATE ON "calendar_event_copies" TO bylinecrm_app;

ALTER TABLE "calendar_event_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_event_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "calendar_event_participants"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- UPDATE re-points a match and follows an answer; DELETE drops an attendee taken off the invitation.
GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_event_participants" TO bylinecrm_app;

ALTER TABLE "calendar_sync_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_sync_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "calendar_sync_states"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "calendar_sync_states" TO bylinecrm_app;
