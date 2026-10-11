-- P0-14: sign-up lockdown. A platform admin (an address in PLATFORM_ADMIN_EMAILS) creates a workspace
-- and invites its owner, so a workspace invitation can now come from a platform user rather than a
-- member; platform sign-up invitations exist for `invite` mode; and every platform action is
-- recorded in an append-only audit table. Both new tables are global and operator-level: the app
-- role gets no grant on them, and the platform service reaches them through the owner client.

-- AlterTable: an invitation names exactly one inviter — a member, or a platform user.
ALTER TABLE "workspace_invites" ALTER COLUMN "invited_by_id" DROP NOT NULL,
ADD COLUMN     "invited_by_user_id" UUID;

ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_one_inviter"
    CHECK (num_nonnulls("invited_by_id", "invited_by_user_id") = 1);

-- CreateTable
CREATE TABLE "platform_signup_invites" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_signup_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "subject" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_signup_invites_token_hash_key" ON "platform_signup_invites"("token_hash");
CREATE INDEX "platform_signup_invites_email_idx" ON "platform_signup_invites"("email");
CREATE INDEX "platform_audit_occurred_at_idx" ON "platform_audit"("occurred_at");

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_signup_invites" ADD CONSTRAINT "platform_signup_invites_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The audit is append-only for every role, the owner included: a row, once written, is the record.
-- (A superuser can still disable the trigger; that is an operator act outside the application.)
CREATE FUNCTION platform_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'platform_audit is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER platform_audit_append_only
    BEFORE UPDATE OR DELETE ON "platform_audit"
    FOR EACH ROW EXECUTE FUNCTION platform_audit_append_only();
CREATE TRIGGER platform_audit_no_truncate
    BEFORE TRUNCATE ON "platform_audit"
    FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_append_only();

-- Out of the app role's reach.
REVOKE ALL ON "platform_signup_invites" FROM bylinecrm_app;
REVOKE ALL ON "platform_audit" FROM bylinecrm_app;
