-- OWN-2d: a company nobody owns is claimed by the first member to save a person at it. The Bigin import set owners on
-- people, not on their companies, so 93k production companies name no owner and the company-ownership rule (OWN-2)
-- never fired for them. The claim is made in the person's own transaction. Under row-level security an own-scoped
-- member (`recordScope: 'own'`) cannot see — so cannot update — a company with no owner; the claim runs in one function
-- the app role may execute, as a role past RLS that may update companies and read members and nothing else, with the
-- workspace taken from the transaction's settings and the member held to the transaction's own owner scope.
--
-- Schema only: no rows change. The companies already imported without an owner are filled by the batched CLI job
-- `assign-company-owners.js`, never by a migration.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bylinecrm_ownership') THEN
        CREATE ROLE bylinecrm_ownership NOLOGIN BYPASSRLS;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO bylinecrm_ownership;
GRANT SELECT, UPDATE ON "companies" TO bylinecrm_ownership;
GRANT SELECT ON "workspace_members" TO bylinecrm_ownership;

-- Gives the current workspace's live company p_company, if it has no owner, to p_member, a member who has not left;
-- true when it did. An own-scoped caller may claim for themselves only. Nothing else of the company changes.
CREATE FUNCTION claim_company(p_company uuid, p_member uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    n int;
BEGIN
    IF app_owner_member_id() IS NOT NULL AND p_member IS DISTINCT FROM app_owner_member_id() THEN
        RAISE EXCEPTION 'claim_company: an own-scoped member claims a company for themselves only';
    END IF;
    UPDATE companies c SET owner_id = p_member, updated_at = now()
    WHERE c.id = p_company AND c.workspace_id = app_workspace_id() AND c.owner_id IS NULL AND c.deleted_at IS NULL
      AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.id = p_member AND m.workspace_id = app_workspace_id() AND m.left_at IS NULL
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END
$$;

ALTER FUNCTION claim_company(uuid, uuid) OWNER TO bylinecrm_ownership;
REVOKE ALL ON FUNCTION claim_company(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_company(uuid, uuid) TO bylinecrm_app;
