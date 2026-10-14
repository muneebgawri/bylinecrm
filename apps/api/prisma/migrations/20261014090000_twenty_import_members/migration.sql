-- #184 (P4-4e): the importer creates accounts for Twenty members who are not here. A seat says how it
-- came to be; a run remembers the role it gave the accounts it made, and how many.
-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "twenty_import_runs" ADD COLUMN     "accounts_created" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "create_members_role_id" UUID;

-- AddForeignKey
ALTER TABLE "twenty_import_runs" ADD CONSTRAINT "twenty_import_runs_create_members_role_id_fkey" FOREIGN KEY ("create_members_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the column promises: a seat's source is one of the three ways a seat is made.
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_source_known"
    CHECK ("source" IS NULL OR "source" IN ('signup', 'invite', 'twenty-import'));
