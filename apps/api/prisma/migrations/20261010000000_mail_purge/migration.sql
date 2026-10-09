-- P2-2 review: synced mail can be taken back. Two cases, both inside one workspace:
--   * a blocklist entry purges stored mail it now fully covers (messages, their participants,
--     threads left empty, and the mail's timeline entries);
--   * a person losing an address takes that mail's entries off their records.
--
-- `mail_messages` and `mail_threads` become deletable by the app role (only the blocklist purge
-- deletes them; participants go with their message by the foreign key).
--
-- The timeline stays append-only for the app role: it gets no DELETE grant, and P1-3's test that a
-- DELETE is refused still holds. Synced mail's entries — and only those — are removed through one
-- function the app role may execute. It runs as the table's owner under a policy that admits only
-- `linked_type = 'email'` rows of the current workspace, and it names the workspace in its own
-- WHERE as well, so it removes nothing else even for an owner that bypasses row-level security.

GRANT DELETE ON "mail_messages" TO bylinecrm_app;
GRANT DELETE ON "mail_threads" TO bylinecrm_app;

CREATE POLICY email_entries_removable ON "timeline_activities"
    FOR DELETE TO CURRENT_USER
    USING (workspace_id = app_workspace_id() AND linked_type = 'email');

-- Removes synced mail's timeline entries in the current workspace: every entry of the given
-- messages (`p_target_ids` null), or the given (message, record) pairs (parallel arrays).
CREATE FUNCTION delete_email_timeline_entries(p_linked_ids uuid[], p_target_ids uuid[])
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    removed integer;
BEGIN
    IF app_workspace_id() IS NULL THEN
        RETURN 0;
    END IF;
    IF p_target_ids IS NULL THEN
        DELETE FROM timeline_activities t
        WHERE t.workspace_id = app_workspace_id()
          AND t.linked_type = 'email'
          AND t.linked_id = ANY (p_linked_ids);
    ELSE
        DELETE FROM timeline_activities t
        USING unnest(p_linked_ids, p_target_ids) AS x(linked_id, target_id)
        WHERE t.workspace_id = app_workspace_id()
          AND t.linked_type = 'email'
          AND t.linked_id = x.linked_id
          AND t.target_id = x.target_id;
    END IF;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END
$$;

REVOKE ALL ON FUNCTION delete_email_timeline_entries(uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_email_timeline_entries(uuid[], uuid[]) TO bylinecrm_app;
