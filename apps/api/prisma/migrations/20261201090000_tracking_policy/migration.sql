-- TRACK-2: tracking is an admin's choice (Settings → Tracking): built in or SMTP2Go's, opens and clicks each on or
-- off, CRM-written mail tracked by default or not, and reply notices for mail sent straight from Gmail.
CREATE TYPE "tracking_provider" AS ENUM ('builtin', 'smtp2go');

CREATE TABLE "tracking_policies" (
    "workspace_id" UUID NOT NULL,
    "provider" "tracking_provider" NOT NULL DEFAULT 'builtin',
    "track_opens" BOOLEAN NOT NULL DEFAULT true,
    "track_clicks" BOOLEAN NOT NULL DEFAULT true,
    "track_personal_mail" BOOLEAN NOT NULL DEFAULT false,
    "gmail_reply_notices" BOOLEAN NOT NULL DEFAULT true,
    "relay_key_ciphertext" TEXT,
    "relay_hook_secret_ciphertext" TEXT,
    "last_relay_hook_at" TIMESTAMPTZ,
    "last_relay_hook_result" TEXT,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tracking_policies_pkey" PRIMARY KEY ("workspace_id")
);
ALTER TABLE "tracking_policies" ADD CONSTRAINT "tracking_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tracking_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "tracking_policies"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "tracking_policies" TO bylinecrm_app;

-- A send says whether it is tracked and whether it went through the relay. Both default false: a constant default
-- is a catalogue change only, so existing rows are not rewritten.
ALTER TABLE "mail_outbound" ADD COLUMN "tracked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mail_outbound" ADD COLUMN "via_relay" BOOLEAN NOT NULL DEFAULT false;
