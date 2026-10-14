-- #185 (with #184): the accounts option is the workspace's saved choice — the role chosen at the last start,
-- null for off — so a scheduled run creates accounts for Twenty members who are not here the way a person's
-- start would, with that role, and never mails anyone.
-- AlterTable
ALTER TABLE "twenty_import_settings" ADD COLUMN     "create_members_role_id" UUID;

-- AddForeignKey
ALTER TABLE "twenty_import_settings" ADD CONSTRAINT "twenty_import_settings_create_members_role_id_fkey" FOREIGN KEY ("create_members_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
