-- OWN-2f: a company whose owner has not worked it in DORMANT_OWNER_MONTHS is taken over by the next member to save a
-- person at it. claim_company now takes the owner the caller read (`p_from`, null for a company naming none, the
-- default, so a two-argument call is the OWN-2d claim it was): the claim holds only while the company still names
-- that owner, and never takes a company from the claimer themselves. Whether an owner is dormant is the
-- application's reading (CompanyOwnership); this function only makes the change.
--
-- Schema only: no rows change.

DROP FUNCTION claim_company(uuid, uuid);

CREATE FUNCTION claim_company(p_company uuid, p_member uuid, p_from uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    n int;
BEGIN
    IF app_owner_member_id() IS NOT NULL AND p_member IS DISTINCT FROM app_owner_member_id() THEN
        RAISE EXCEPTION 'claim_company: an own-scoped member claims a company for themselves only';
    END IF;
    IF p_from IS NOT NULL AND p_from = p_member THEN
        RETURN false;
    END IF;
    UPDATE companies c SET owner_id = p_member, updated_at = now()
    WHERE c.id = p_company AND c.workspace_id = app_workspace_id() AND c.owner_id IS NOT DISTINCT FROM p_from
      AND c.deleted_at IS NULL
      AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.id = p_member AND m.workspace_id = app_workspace_id() AND m.left_at IS NULL
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END
$$;

ALTER FUNCTION claim_company(uuid, uuid, uuid) OWNER TO bylinecrm_ownership;
REVOKE ALL ON FUNCTION claim_company(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_company(uuid, uuid, uuid) TO bylinecrm_app;
