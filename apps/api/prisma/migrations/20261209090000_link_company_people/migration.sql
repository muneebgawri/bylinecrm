-- OWN-2g: a company saved at a domain where leads were saved before it takes those leads in. A member links a
-- colleague's lead (which their owner scope cannot see, so cannot update) at the company they save, so the link runs
-- in one function the app role may execute, as the ownership role past RLS. Which leads to link is the
-- application's reading (CompanyOwnership.domainLeads); this function only sets their company, and only for live
-- people of the current workspace that have none.
--
-- Schema only: no rows change. The leads already waiting are linked by the batched CLI job `link-domain-people.js`,
-- never by a migration.

GRANT SELECT ON "people" TO bylinecrm_ownership;
GRANT UPDATE ("company_id", "updated_at") ON "people" TO bylinecrm_ownership;

CREATE FUNCTION link_company_people(p_company uuid, p_people uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    n int;
BEGIN
    UPDATE people p SET company_id = p_company, updated_at = now()
    WHERE p.id = ANY(p_people) AND p.workspace_id = app_workspace_id() AND p.company_id IS NULL
      AND p.deleted_at IS NULL
      AND EXISTS (
          SELECT 1 FROM companies c
          WHERE c.id = p_company AND c.workspace_id = app_workspace_id() AND c.deleted_at IS NULL
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

ALTER FUNCTION link_company_people(uuid, uuid[]) OWNER TO bylinecrm_ownership;
REVOKE ALL ON FUNCTION link_company_people(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION link_company_people(uuid, uuid[]) TO bylinecrm_app;
