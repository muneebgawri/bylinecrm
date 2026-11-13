-- Settings → Ownership: the member a record goes to when its owner releases it (the house account). Null: releasing
-- is off. A member who is removed leaves it null. Schema only: a nullable column, no row is rewritten.
ALTER TABLE "ownership_settings" ADD COLUMN "release_to_member_id" UUID;
ALTER TABLE "ownership_settings" ADD CONSTRAINT "ownership_settings_release_to_member_id_fkey"
    FOREIGN KEY ("release_to_member_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
