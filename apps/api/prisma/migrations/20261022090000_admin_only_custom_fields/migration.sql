-- An admin may mark a custom field admin-only: callers without `workspace:admin` do not see its definition or its
-- values, and may not write it. Imports and jobs are unaffected.
ALTER TABLE "custom_field_definitions" ADD COLUMN "admin_only" BOOLEAN NOT NULL DEFAULT false;
