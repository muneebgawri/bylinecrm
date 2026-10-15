-- CAL-3: suggested leads (owner, 2026-10-15). A meeting attendee who may not be a lead — the member was invited by
-- someone outside (a vendor's pitch), or the attendee is at a free-mail domain (a friend) — is suggested to the
-- member instead of being made a person. The member adds it as a lead or dismisses it; a dismissed address is
-- not suggested to them again. A meeting counts towards a member's KPIs only while one of its outside attendees
-- is a live person that member owns (the KPI query reads that; nothing is stored for it).

-- AlterTable
ALTER TABLE "calendar_event_participants" ADD COLUMN     "lead_dismissed_at" TIMESTAMPTZ,
ADD COLUMN     "lead_suggested_for_member_id" UUID;

-- CreateIndex
CREATE INDEX "calendar_event_participants_workspace_id_lead_suggested_for_idx" ON "calendar_event_participants"("workspace_id", "lead_suggested_for_member_id", "address");

-- AddForeignKey
ALTER TABLE "calendar_event_participants" ADD CONSTRAINT "calendar_event_participants_lead_suggested_for_member_id_fkey" FOREIGN KEY ("lead_suggested_for_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

