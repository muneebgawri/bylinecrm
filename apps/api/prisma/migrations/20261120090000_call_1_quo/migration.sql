-- CALL-1: calls with Quo (formerly OpenPhone). Expand only: two tables, three enums, one nullable column on
-- workspace_members; no backfill.

ALTER TYPE "linked_object" ADD VALUE IF NOT EXISTS 'call';

CREATE TYPE "call_direction" AS ENUM ('outbound', 'inbound');
CREATE TYPE "call_status" AS ENUM ('answered', 'missed', 'voicemail', 'unanswered', 'logged');
CREATE TYPE "call_disposition" AS ENUM ('connected', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'callback', 'not_interested');

ALTER TABLE "workspace_members" ADD COLUMN "quo_user_id" TEXT;

CREATE TABLE "quo_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "api_key_ciphertext" TEXT NOT NULL,
    "webhook_id" TEXT,
    "webhook_secret_ciphertext" TEXT,
    "unmatched_quo_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "configured_by_id" UUID NOT NULL,
    "last_delivery_at" TIMESTAMPTZ,
    "last_delivery_result" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "quo_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quo_settings_workspace_id_key" ON "quo_settings"("workspace_id");
ALTER TABLE "quo_settings" ADD CONSTRAINT "quo_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quo_settings" ADD CONSTRAINT "quo_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'quo',
    "external_id" TEXT,
    "person_id" UUID,
    "member_id" UUID,
    "direction" "call_direction" NOT NULL,
    "status" "call_status" NOT NULL,
    "from_number" TEXT,
    "to_number" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL,
    "answered_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "duration_sec" INTEGER,
    "has_voicemail" BOOLEAN NOT NULL DEFAULT false,
    "recordings" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB,
    "transcript" JSONB,
    "disposition" "call_disposition",
    "note_id" UUID,
    "quo_link" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "calls_workspace_id_provider_external_id_key" ON "calls"("workspace_id", "provider", "external_id");
CREATE INDEX "calls_workspace_id_person_id_started_at_idx" ON "calls"("workspace_id", "person_id", "started_at");
CREATE INDEX "calls_workspace_id_member_id_started_at_idx" ON "calls"("workspace_id", "member_id", "started_at");
ALTER TABLE "calls" ADD CONSTRAINT "calls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security: a workspace's calls and its Quo link are its own.
ALTER TABLE "quo_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quo_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "quo_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quo_settings" TO bylinecrm_app;

ALTER TABLE "calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "calls"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "calls" TO bylinecrm_app;
