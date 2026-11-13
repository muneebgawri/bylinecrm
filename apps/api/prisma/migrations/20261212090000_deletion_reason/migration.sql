-- Why a record is in the trash, and who put it there: shown on the Trash screen beside "Restore". All three are
-- null for a live record and cleared by a restore. Schema only: nullable columns with no default, so no row is
-- rewritten. `deleted_by_member_id` is a plain id (no foreign key): a member who is later removed is still named
-- by the events of the time, and the column needs no lock on `workspace_members`.
ALTER TABLE "people" ADD COLUMN "deleted_reason" TEXT, ADD COLUMN "deleted_note" TEXT, ADD COLUMN "deleted_by_member_id" UUID;
ALTER TABLE "companies" ADD COLUMN "deleted_reason" TEXT, ADD COLUMN "deleted_note" TEXT, ADD COLUMN "deleted_by_member_id" UUID;
ALTER TABLE "opportunities" ADD COLUMN "deleted_reason" TEXT, ADD COLUMN "deleted_note" TEXT, ADD COLUMN "deleted_by_member_id" UUID;
