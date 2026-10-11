-- P3-1: the suppression list and the secrets behind unsubscribe links (FR-CRMS-7). `suppressions`
-- holds every address the workspace never mails — one live entry per address; lifting one keeps the row
-- and records who, when and why. `unsubscribe_tokens` holds the SHA-256 of each link's token, one per
-- (workspace, recipient, message). Nothing deletes from either.

-- CreateEnum
CREATE TYPE "suppression_reason" AS ENUM ('unsubscribe', 'hard_bounce', 'complaint', 'manual');

-- CreateEnum
CREATE TYPE "suppression_source" AS ENUM ('recipient', 'member', 'provider');

-- CreateTable
CREATE TABLE "suppressions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "reason" "suppression_reason" NOT NULL,
    "source" "suppression_source" NOT NULL,
    "person_id" UUID,
    "outbound_id" UUID,
    "note" TEXT,
    "created_by_member_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,
    "removed_by_member_id" UUID,
    "removal_note" TEXT,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unsubscribe_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "person_id" UUID,
    "outbound_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ,

    CONSTRAINT "unsubscribe_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppressions_workspace_id_created_at_idx" ON "suppressions"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "unsubscribe_tokens_token_hash_key" ON "unsubscribe_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "unsubscribe_tokens_workspace_id_address_idx" ON "unsubscribe_tokens"("workspace_id", "address");

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "mail_outbound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_member_id_fkey" FOREIGN KEY ("created_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_removed_by_member_id_fkey" FOREIGN KEY ("removed_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "mail_outbound"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One live entry per address; the checks every send and enrolment make read this index.
CREATE UNIQUE INDEX "suppressions_live_address_key" ON "suppressions"("workspace_id", "address") WHERE "removed_at" IS NULL;

-- What the columns promise, beyond their types: addresses are stored lower case; a lifted entry says
-- when and why (and who, unless that member has since left); only a liftable reason is ever lifted —
-- an unsubscribe or a complaint is the person's choice and stays.
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_address_lower" CHECK ("address" = lower("address"));
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_removal_complete"
    CHECK (("removed_at" IS NULL AND "removal_note" IS NULL) OR ("removed_at" IS NOT NULL AND "removal_note" IS NOT NULL));
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_removal_liftable"
    CHECK ("removed_at" IS NULL OR "reason" IN ('hard_bounce', 'manual'));
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_address_lower" CHECK ("address" = lower("address"));

-- Row-level security in P0-2's shape. UPDATE lifts an entry and marks a token used; no DELETE.
ALTER TABLE "suppressions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppressions" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "suppressions"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "suppressions" TO bylinecrm_app;

ALTER TABLE "unsubscribe_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unsubscribe_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "unsubscribe_tokens"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON "unsubscribe_tokens" TO bylinecrm_app;
