-- Lead pools, saving: any live lead one workspace of a pool has — cold or not — cannot be saved in another
-- (it was only a customer or prospect). The refusal still names only the workspace that has it. People
-- already saved in both stay; only a new claim (a save, a changed primary email, a restore) is checked.
--
-- Mail and payments keep the narrower rule: `lead_pool_holders(emails, false)` is the customer or prospect
-- the recipient guard refuses and NewswireOS payments leave to the other workspace — a cold lead saved in
-- both before this stays mailable in both. `lead_pool_holders(emails, true)` is any lead, for a save.

DROP FUNCTION lead_pool_holders(text[]);

CREATE FUNCTION lead_pool_holders(p_emails text[], p_any_lead boolean)
    RETURNS TABLE (email text, workspace_name text)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT ON (a.email) a.email, w.name
    FROM workspaces me
    JOIN lead_pool_addresses a ON a.pool_id = me.lead_pool_id
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE me.id = app_workspace_id() AND a.email = ANY (p_emails) AND a.workspace_id <> me.id
      AND (p_any_lead OR lead_pool_protected(a.person_id))
    ORDER BY a.email, w.name
$$;
REVOKE ALL ON FUNCTION lead_pool_holders(text[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_pool_holders(text[], boolean) TO bylinecrm_app;

CREATE OR REPLACE FUNCTION people_lead_pool_claim()
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
