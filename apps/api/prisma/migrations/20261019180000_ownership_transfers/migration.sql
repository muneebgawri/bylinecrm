-- OWN-1 (#200, FR-CRMS-17/18): ownership transfers — the one way a record changes hands — the `manager`
-- system role in every workspace, and notifications about a transfer beside those about a task.

-- CreateEnum
CREATE TYPE "transfer_status" AS ENUM ('proposed', 'accepted', 'declined', 'cancelled', 'forced');

-- AlterEnum
ALTER TYPE "notification_kind" ADD VALUE 'transfer_proposed';
ALTER TYPE "notification_kind" ADD VALUE 'transfer_accepted';
ALTER TYPE "notification_kind" ADD VALUE 'transfer_declined';
ALTER TYPE "notification_kind" ADD VALUE 'transfer_received';
ALTER TYPE "notification_kind" ADD VALUE 'transfer_taken';

-- CreateTable
CREATE TABLE "ownership_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "object" "record_object" NOT NULL,
    "record_id" UUID NOT NULL,
    "from_member_id" UUID,
    "to_member_id" UUID NOT NULL,
    "proposed_by_member_id" UUID NOT NULL,
    "decided_by_member_id" UUID,
    "status" "transfer_status" NOT NULL DEFAULT 'proposed',
    "reason" TEXT,
    "note" TEXT,
    "moved" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ownership_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ownership_transfers_workspace_id_object_record_id_created_a_idx" ON "ownership_transfers"("workspace_id", "object", "record_id", "created_at" DESC);
CREATE INDEX "ownership_transfers_workspace_id_to_member_id_status_idx" ON "ownership_transfers"("workspace_id", "to_member_id", "status");
CREATE INDEX "ownership_transfers_workspace_id_from_member_id_status_idx" ON "ownership_transfers"("workspace_id", "from_member_id", "status");
-- One open proposal per record.
CREATE UNIQUE INDEX "ownership_transfers_open_record_key" ON "ownership_transfers"("workspace_id", "object", "record_id") WHERE "status" = 'proposed';

-- A decided transfer says who and when; a proposed one neither.
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_decided_shape"
    CHECK (("status" = 'proposed') = ("decided_at" IS NULL));

-- AddForeignKey
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_from_member_id_fkey" FOREIGN KEY ("from_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_to_member_id_fkey" FOREIGN KEY ("to_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_proposed_by_member_id_fkey" FOREIGN KEY ("proposed_by_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_decided_by_member_id_fkey" FOREIGN KEY ("decided_by_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security: a workspace's transfers are its own; the service decides which member sees which.
ALTER TABLE "ownership_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ownership_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "ownership_transfers"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- History: never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON "ownership_transfers" TO bylinecrm_app;

-- Notifications: about a task, or about a transfer — exactly one.
ALTER TABLE "notifications" ALTER COLUMN "task_id" DROP NOT NULL;
ALTER TABLE "notifications" ADD COLUMN "transfer_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "ownership_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "notifications_member_id_kind_transfer_id_key" ON "notifications"("member_id", "kind", "transfer_id");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing"
    CHECK (("task_id" IS NULL) <> ("transfer_id" IS NULL));

-- The `manager` system role in every workspace that has none (FR-CRMS-18). A workspace whose admin already
-- made a custom role named `manager` keeps it as it is: a custom role, not this one.
INSERT INTO "roles" ("id", "workspace_id", "name", "is_system", "record_scope", "created_at", "updated_at")
SELECT gen_random_uuid(), w."id", 'manager', true, 'all', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "workspaces" w
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."workspace_id" = w."id" AND r."name" = 'manager');

INSERT INTO "role_permissions" ("id", "workspace_id", "role_id", "capability")
SELECT gen_random_uuid(), r."workspace_id", r."id", c.capability
FROM "roles" r
CROSS JOIN (VALUES
    ('record:read'), ('record:write'), ('record:transfer'), ('note:write'), ('task:write'),
    ('deal:read'), ('deal:move'), ('deal:edit'), ('deal:bulk'), ('view:save'), ('view:share'),
    ('email:send'), ('template:read'), ('template:write'), ('template:send_test'),
    ('sequence:write'), ('sequence:enrol'), ('mailbox:read'), ('mailbox:manage')
) AS c(capability)
WHERE r."name" = 'manager' AND r."is_system"
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role_id" = r."id" AND p."capability" = c.capability);

-- A completed transfer leaves a `linked-transfer.completed` entry on every record that moved.
ALTER TYPE "linked_object" ADD VALUE 'transfer';
