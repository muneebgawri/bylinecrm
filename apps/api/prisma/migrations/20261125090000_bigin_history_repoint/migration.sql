-- BIGIN-1 review: applying the Bigin stage mapping re-points imported stage history too. An imported stage move
-- (`source = 'bigin'`, `kind = 'deal.stage_changed'`, keyed `stage-history:<Bigin id>`) names the pipeline stages it
-- left and entered in `properties.diff.stageId`, resolved through the mapping as it stood at import time; when the
-- mapping changes, "Apply to imported deals" resolves them again and re-points the entries that now land elsewhere.
--
-- The timeline stays append-only for the app role: it gets no UPDATE grant, and P1-3's test that an UPDATE is
-- refused still holds. Imported stage moves — and only those, and only their `diff.stageId` — are re-pointed through
-- one function the app role may execute, as synced mail's entries are removed (20261010000000_mail_purge). It runs as
-- the table's owner under a policy that admits only imported stage moves of the current workspace, and names the
-- workspace and the entry's shape in its own WHERE as well.
--
-- Schema only: no rows are changed here. The apply job calls it a chunk at a time.

CREATE POLICY imported_stage_history_repointable ON "timeline_activities"
    FOR UPDATE TO CURRENT_USER
    USING (workspace_id = app_workspace_id() AND source = 'bigin' AND kind = 'deal.stage_changed')
    WITH CHECK (workspace_id = app_workspace_id() AND source = 'bigin' AND kind = 'deal.stage_changed');

-- The current workspace's imported stage moves `p_ids` get `diff.stageId` = {from: p_from[i], to: p_to[i]} (a null
-- `from`: the stage the deal started in); everything else in the entry is kept. Returns how many changed.
CREATE FUNCTION repoint_imported_stage_history(p_ids uuid[], p_from uuid[], p_to uuid[])
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    IF app_workspace_id() IS NULL THEN
        RETURN 0;
    END IF;
    UPDATE timeline_activities t
       SET properties = jsonb_set(
               t.properties,
               '{diff,stageId}',
               jsonb_build_object('from', x.from_id, 'to', x.to_id)
           )
      FROM unnest(p_ids, p_from, p_to) AS x(id, from_id, to_id)
     WHERE t.id = x.id
       AND t.workspace_id = app_workspace_id()
       AND t.source = 'bigin'
       AND t.kind = 'deal.stage_changed'
       AND t.idempotency_key LIKE 'stage-history:%'
       AND x.to_id IS NOT NULL
       AND jsonb_typeof(t.properties -> 'diff' -> 'stageId') = 'object'
       AND (t.properties -> 'diff' -> 'stageId') IS DISTINCT FROM jsonb_build_object('from', x.from_id, 'to', x.to_id);
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END
$$;

REVOKE ALL ON FUNCTION repoint_imported_stage_history(uuid[], uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION repoint_imported_stage_history(uuid[], uuid[], uuid[]) TO bylinecrm_app;
