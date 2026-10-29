-- 2FA-1: two-factor sign-in with an authenticator app. Expand only: two nullable columns on users,
-- one enum value, one new table — nothing rewritten, no backfill.

ALTER TYPE "OneTimeTokenPurpose" ADD VALUE 'two_factor';

ALTER TABLE "users" ADD COLUMN "totp_secret" TEXT,
                    ADD COLUMN "totp_enabled_at" TIMESTAMPTZ;

CREATE TABLE "two_factor_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "two_factor_recovery_codes_code_hash_key" ON "two_factor_recovery_codes"("code_hash");
CREATE INDEX "two_factor_recovery_codes_user_id_idx" ON "two_factor_recovery_codes"("user_id");
ALTER TABLE "two_factor_recovery_codes" ADD CONSTRAINT "two_factor_recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The person sets up, disables and re-codes their own second factor through the restricted client, like
-- their profile (P1-UI-10): column grants on their own row, and a policy on their own codes. The sign-in
-- path reads and spends through the owner client, as the password check does.
GRANT UPDATE ("totp_secret", "totp_enabled_at") ON "users" TO bylinecrm_app;

ALTER TABLE "two_factor_recovery_codes" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factor_recovery_codes" TO bylinecrm_app;
CREATE POLICY own_codes ON "two_factor_recovery_codes"
    FOR ALL TO bylinecrm_app
    USING (user_id = app_user_id())
    WITH CHECK (user_id = app_user_id());
