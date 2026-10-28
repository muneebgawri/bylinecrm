-- Lead pools: workspaces that share one set of leads (Pinion Newswire and Lexiswire). A live person's
-- primary email in one workspace of a pool cannot be saved in another; a person in the trash holds
-- nothing. A workspace in no pool is untouched. The operator joins workspaces with the CLI
-- `link-lead-pool`, which also records the people already there (in batches, not here).
--
-- The rule is kept by a trigger on `people`, so every writer — a person saved in the app, an
-- import, a merge, a restore from the trash — meets it. Another workspace's rows are read only by
-- the two functions below, which run as the owner and return no more than that workspace's name.

CREATE TABLE "lead_pools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pools_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_pools_name_key" ON "lead_pools"("name");

ALTER TABLE "workspaces" ADD COLUMN "lead_pool_id" UUID;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_lead_pool_id_fkey"
    FOREIGN KEY ("lead_pool_id") REFERENCES "lead_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per live person with a primary email in a pooled workspace. People saved twice before
-- their workspaces were pooled keep both rows; only a new claim is checked.
CREATE TABLE "lead_pool_addresses" (
    "person_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "lead_pool_addresses_pkey" PRIMARY KEY ("person_id")
);
CREATE INDEX "lead_pool_addresses_pool_id_email_idx" ON "lead_pool_addresses"("pool_id", "email");
CREATE INDEX "lead_pool_addresses_workspace_id_idx" ON "lead_pool_addresses"("workspace_id");
ALTER TABLE "lead_pool_addresses" ADD CONSTRAINT "lead_pool_addresses_person_id_fkey"
    FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_pool_addresses" ADD CONSTRAINT "lead_pool_addresses_pool_id_fkey"
    FOREIGN KEY ("pool_id") REFERENCES "lead_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_pool_addresses" ADD CONSTRAINT "lead_pool_addresses_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The app role has no grant on either table; the policy scopes any grant added later, like every
-- tenant table's.
ALTER TABLE "lead_pool_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_pool_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "lead_pool_addresses"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());

-- Keeps a person's row in step with it, and refuses an address another workspace of the pool holds
-- (a unique violation, so every writer's existing duplicate handling answers it).
CREATE FUNCTION people_lead_pool_claim()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    pool uuid;
    holder text;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND OLD.email_primary IS NOT NULL THEN
        IF NEW.deleted_at IS NULL AND NEW.email_primary IS NOT DISTINCT FROM OLD.email_primary THEN
            RETURN NULL;
        END IF;
        DELETE FROM lead_pool_addresses WHERE person_id = OLD.id;
    END IF;
    IF NEW.deleted_at IS NOT NULL OR NEW.email_primary IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT lead_pool_id INTO pool FROM workspaces WHERE id = NEW.workspace_id;
    IF pool IS NULL THEN
        RETURN NULL;
    END IF;
    -- Two workspaces saving the same address at once: the second waits, then sees the first.
    PERFORM pg_advisory_xact_lock(hashtextextended(pool::text || ':' || NEW.email_primary, 0));
    SELECT w.name INTO holder
    FROM lead_pool_addresses a
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.pool_id = pool AND a.email = NEW.email_primary AND a.workspace_id <> NEW.workspace_id
    ORDER BY w.name
    LIMIT 1;
    IF holder IS NOT NULL THEN
        RAISE EXCEPTION 'a person with that primary email is already a lead in %', holder
            USING ERRCODE = 'unique_violation', CONSTRAINT = 'lead_pool_addresses_email';
    END IF;
    INSERT INTO lead_pool_addresses (person_id, pool_id, workspace_id, email)
    VALUES (NEW.id, pool, NEW.workspace_id, NEW.email_primary)
    ON CONFLICT (person_id) DO UPDATE SET pool_id = EXCLUDED.pool_id, email = EXCLUDED.email;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION people_lead_pool_claim() FROM PUBLIC;

CREATE TRIGGER people_lead_pool_claim
    AFTER INSERT OR UPDATE OF email_primary, deleted_at ON "people"
    FOR EACH ROW EXECUTE FUNCTION people_lead_pool_claim();

-- The name of another workspace in the current workspace's pool whose live person has this address;
-- null for none (or no pool). Nothing else of that workspace is returned.
CREATE FUNCTION lead_pool_holder(p_email text)
    RETURNS text
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
    SELECT w.name
    FROM workspaces me
    JOIN lead_pool_addresses a ON a.pool_id = me.lead_pool_id
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE me.id = app_workspace_id() AND a.email = p_email AND a.workspace_id <> me.id
    ORDER BY w.name
    LIMIT 1
$$;
REVOKE ALL ON FUNCTION lead_pool_holder(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_pool_holder(text) TO bylinecrm_app;
