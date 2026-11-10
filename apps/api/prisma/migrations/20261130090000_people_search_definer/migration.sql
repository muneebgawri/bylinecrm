-- People search uses its indexes again (#344). Under row-level security only leakproof operators may become index
-- conditions, and neither `@@` (full text) nor `LIKE` is leakproof: every search was a parallel seq scan of the whole
-- workspace — about 165k rows on the largest. The search now runs in one function the app role may execute, as the
-- table's owner (the pattern of 20261010000000_mail_purge and 20261125090000_bigin_history_repoint), with the
-- workspace and the record scope named in its own WHERE, so each branch can use its index.
--
-- Schema only: no rows change.

-- What the prefix branches range over: byte order, so `~>=~` / `~<~` bound a prefix exactly whatever the collation.
CREATE INDEX IF NOT EXISTS "people_email_primary_prefix_idx"
    ON "people" ("workspace_id", "email_primary" text_pattern_ops) WHERE "email_primary" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "person_addresses_prefix_idx"
    ON "person_addresses" ("workspace_id", "address" text_pattern_ops);

-- The owner reads people and their addresses only through people_search below, which names the current workspace and
-- the member's record scope itself. A policy that admits the owner outright (rather than one repeating the workspace
-- test) is what lets the planner use the indexes: any policy qual makes the non-leakproof search operators wait for it.
CREATE POLICY people_search_definer ON "people" FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY person_addresses_search_definer ON "person_addresses" FOR SELECT TO CURRENT_USER USING (true);

-- The current workspace's people a search matches, with their rank, best first, at most p_limit. Three branches, each
-- with its own index: the name/email/title vector (GIN), the primary address's prefix and an additional address's prefix
-- (text_pattern_ops ranges, LIKE as the exact test). p_words is the tsquery ('' for none); p_low/p_high bound the
-- lower-case prefix and p_like is the same prefix as an escaped LIKE pattern. A phone number is matched by the caller
-- (records/search.ts) as before: a regex over the phones has no index to use, so it gains nothing in here.
CREATE FUNCTION people_search(
    p_words text, p_low text, p_high text, p_like text, p_deleted boolean, p_limit int
) RETURNS TABLE (id uuid, rank real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    -- Inlined into each branch (NOT MATERIALIZED), so every branch carries the workspace, the scope and its own index
    -- condition; a materialized CTE would read the whole workspace first, the scan this replaces.
    WITH visible AS NOT MATERIALIZED (
        SELECT p.id, p.search, p.email_primary
        FROM people p
        WHERE app_workspace_id() IS NOT NULL
          AND p.workspace_id = app_workspace_id()
          AND (app_owner_member_id() IS NULL OR p.owner_id = app_owner_member_id())
          AND CASE WHEN p_deleted THEN p.deleted_at IS NOT NULL ELSE p.deleted_at IS NULL END
    ),
    hits AS (
        SELECT v.id, ts_rank(v.search, to_tsquery('simple', p_words)) AS rank
        FROM visible v
        WHERE p_words <> '' AND v.search @@ to_tsquery('simple', p_words)
        UNION ALL
        SELECT v.id, 0 FROM visible v
        WHERE v.email_primary ~>=~ p_low AND v.email_primary ~<~ p_high AND v.email_primary LIKE p_like
        UNION ALL
        SELECT v.id, 0 FROM person_addresses a JOIN visible v ON v.id = a.person_id
        WHERE a.workspace_id = app_workspace_id()
          AND a.address ~>=~ p_low AND a.address ~<~ p_high AND a.address LIKE p_like
    )
    SELECT h.id, max(h.rank) FROM hits h GROUP BY h.id ORDER BY max(h.rank) DESC, h.id LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION people_search(text, text, text, text, boolean, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION people_search(text, text, text, text, boolean, int) TO bylinecrm_app;
