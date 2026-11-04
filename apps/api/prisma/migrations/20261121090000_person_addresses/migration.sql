-- ── Who an address belongs to, answered by an index under row-level security ────────────────────────────────────
-- `people_additional_addresses_idx` (a GIN index over lower(emails->'additional')) is used only by the owner
-- connection: under the app role's row-level security Postgres may use an index only for a leakproof condition,
-- and `lower`, the jsonb cast and `@>` are not. The app still read every person per address (~0.6 s at 164k).
-- So a person's additional addresses, lower case, are kept as rows here; "who lists this address" is then a text
-- equality (leakproof) on a btree. The primary address keeps its own unique index on `people`.
--
-- Kept by a trigger on `people`, so every writer (the app, an import, a merge, a restore) keeps it. A trashed
-- person keeps its rows; the lookup joins `people`, whose policies (workspace, and an own-scoped caller's owner)
-- and `deleted_at` decide who may be found. People saved before this migration are recorded by the CLI
-- `backfill-person-addresses`, in batches, not here.
DROP INDEX "people_additional_addresses_idx";

CREATE TABLE "person_addresses" (
    "person_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "person_created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "person_addresses_pkey" PRIMARY KEY ("person_id", "address")
);
CREATE INDEX "person_addresses_lookup_idx" ON "person_addresses"("workspace_id", "address", "person_created_at", "person_id");
ALTER TABLE "person_addresses" ADD CONSTRAINT "person_addresses_person_id_fkey"
    FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "person_addresses" ADD CONSTRAINT "person_addresses_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "person_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "person_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "person_addresses"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- The app reads; only the trigger (as the owner) and the CLI write.
GRANT SELECT ON "person_addresses" TO bylinecrm_app;

CREATE FUNCTION people_additional_addresses_sync()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.emails -> 'additional' IS NOT DISTINCT FROM OLD.emails -> 'additional' THEN
            RETURN NULL;
        END IF;
        DELETE FROM person_addresses WHERE person_id = NEW.id;
    END IF;
    INSERT INTO person_addresses (person_id, workspace_id, address, person_created_at)
    SELECT NEW.id, NEW.workspace_id, lower(e), NEW.created_at
    FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(NEW.emails -> 'additional') = 'array' THEN NEW.emails -> 'additional' ELSE '[]'::jsonb END
    ) AS e
    WHERE e <> ''
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION people_additional_addresses_sync() FROM PUBLIC;

CREATE TRIGGER people_additional_addresses_sync
    AFTER INSERT OR UPDATE OF emails ON "people"
    FOR EACH ROW EXECUTE FUNCTION people_additional_addresses_sync();
