-- P3-5 The free verification layer (FR-CRMS-14, FR-CRMS-16). docs/design-notes/P3-5.md.

-- An address found not deliverable when checked again before a step stops the enrolment.
ALTER TYPE "enrolment_stop_reason" ADD VALUE 'invalid_address';

CREATE TYPE "email_verification_result" AS ENUM ('valid', 'invalid', 'risky', 'unknown');

CREATE TABLE "email_verifications" (
    "workspace_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "result" "email_verification_result" NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("workspace_id","address")
);

CREATE TABLE "email_verification_settings" (
    "workspace_id" UUID NOT NULL,
    "max_age_days" INTEGER NOT NULL DEFAULT 90,
    "updated_by_member_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "email_verification_settings_pkey" PRIMARY KEY ("workspace_id")
);

ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_verification_settings" ADD CONSTRAINT "email_verification_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_verification_settings" ADD CONSTRAINT "email_verification_settings_updated_by_member_id_fkey" FOREIGN KEY ("updated_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the schema cannot say: an address is stored as compared (lower case, trimmed), and the age
-- a workspace sets is within what the API offers (EMAIL_VERIFICATION_LIMITS in @bylinecrm/shared).
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_address_lower"
    CHECK ("address" = lower(btrim("address")) AND position('@' IN "address") > 1);
ALTER TABLE "email_verification_settings" ADD CONSTRAINT "email_verification_settings_max_age_days_range"
    CHECK ("max_age_days" BETWEEN 1 AND 365);

-- Row-level security: both tables are a workspace's. Neither is deleted by the app role — a result is
-- replaced by the next check, and the settings row is an override that is updated, never removed.
ALTER TABLE "email_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "email_verifications"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "email_verifications" TO bylinecrm_app;

ALTER TABLE "email_verification_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verification_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "email_verification_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "email_verification_settings" TO bylinecrm_app;
