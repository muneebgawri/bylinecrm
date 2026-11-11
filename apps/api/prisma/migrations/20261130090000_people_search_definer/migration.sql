-- People search uses its indexes again (#344). Under row-level security only leakproof operators may become index
-- conditions, and neither `@@` (full text) nor `LIKE` is leakproof: every search was a parallel seq scan of the whole
-- workspace — about 165k rows on the largest (288 ms on production). The search now runs in one function the app role
-- may execute, as a role that bypasses RLS and can read nothing but these two tables, with the workspace and the
-- member's record scope taken from the transaction's settings in its own WHERE, so each branch can use its index.
--
-- Schema only: no rows change.

-- What the prefix branches range over: byte order, so `~>=~` / `~<~` bound a prefix exactly whatever the collation
-- (under en_US.utf8 a default-collation range can miss prefixes with punctuation).
-- A plain build reads each table once and holds off writes to it while it does (seconds on people's 166k rows);
-- CONCURRENTLY cannot run inside a migration.
CREATE INDEX IF NOT EXISTS "people_email_primary_prefix_idx"
    ON "people" ("workspace_id", "email_primary" text_pattern_ops) WHERE "email_primary" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "person_addresses_prefix_idx"
    ON "person_addresses" ("workspace_id", "address" text_pattern_ops);

-- The function's owner: no login, past RLS (so the planner may use the indexes), and SELECT on these two tables only,
-- so a bug in the function can only read people and their addresses — never write, never reach another table.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bylinecrm_search') THEN
        CREATE ROLE bylinecrm_search NOLOGIN BYPASSRLS;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO bylinecrm_search;
GRANT SELECT ON "people", "person_addresses" TO bylinecrm_search;

-- The current workspace's people a search matches, with their rank, best first, at most p_limit. Three branches, each
-- with its own index: the name/email/title vector (GIN), the primary address's prefix and an additional address's prefix
-- (text_pattern_ops ranges, LIKE as the exact test). p_words is the tsquery ('' for none); p_low/p_high bound the
-- lower-case prefix and p_like is the same prefix as an escaped LIKE pattern. The workspace and the record scope are
-- never arguments: they are the transaction's own settings, read exactly as the `people` policies read them, in every
-- branch — so a caller cannot name another workspace, and an own-scoped member's candidates are all their own. A phone
-- number is matched by the caller (records/search.ts) as before: a regex over the phones has no index to use.
CREATE FUNCTION people_search(
    p_words text, p_low text, p_high text, p_like text, p_deleted boolean, p_limit int
) RETURNS TABLE (id uuid, rank real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
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

ALTER FUNCTION people_search(text, text, text, text, boolean, int) OWNER TO bylinecrm_search;
REVOKE ALL ON FUNCTION people_search(text, text, text, text, boolean, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION people_search(text, text, text, text, boolean, int) TO bylinecrm_app;
