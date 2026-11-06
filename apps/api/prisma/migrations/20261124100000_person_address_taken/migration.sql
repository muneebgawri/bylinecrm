-- ── One person per address, additional addresses included ───────────────────────────────────────────────────────
-- The primary address is unique per workspace (the index on `email_primary`), but an additional one was never
-- checked: a person could be saved with an address another person already lists, as their primary or an additional
-- one, and become a second record for the same lead. Now an address a person GAINS — primary or additional — is
-- refused while another person of the workspace holds it either way, trashed ones included, as the primary rule
-- counts them. The refusal is a unique violation, which the app answers as it does a taken primary address (409,
-- naming whose person holds it).
--
-- Only an address the write adds is checked, never one the person already had: two people who share an address from
-- before this keep it, and an edit to either that does not add it again is not refused.
--
-- Who holds an additional address is `person_addresses` (20261121090000), kept by its trigger and, for people saved
-- before it, the `backfill-person-addresses` CLI; an address not yet recorded there is not seen. Dated after that
-- table for this reason: a fresh database builds it first.
--
-- Two saves adding the same address at once: each takes a lock on (workspace, address), in address order, so the
-- second waits for the first and then sees it. Schema only: no rows are changed.
CREATE FUNCTION people_address_taken()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    taken text;
    holder uuid;
BEGIN
    FOR taken IN
        WITH listed(a) AS (
            SELECT lower(NULLIF(NEW.emails ->> 'primary', ''))
            UNION
            SELECT lower(e) FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(NEW.emails -> 'additional') = 'array' THEN NEW.emails -> 'additional' ELSE '[]'::jsonb END
            ) AS e
        ),
        had(a) AS (
            SELECT lower(NULLIF(OLD.emails ->> 'primary', '')) WHERE TG_OP = 'UPDATE'
            UNION
            SELECT lower(e) FROM jsonb_array_elements_text(
                CASE WHEN TG_OP = 'UPDATE' AND jsonb_typeof(OLD.emails -> 'additional') = 'array'
                     THEN OLD.emails -> 'additional' ELSE '[]'::jsonb END
            ) AS e
        )
        SELECT a FROM listed WHERE a IS NOT NULL AND a <> '' AND a NOT IN (SELECT a FROM had WHERE a IS NOT NULL)
        ORDER BY a
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text || ':person-address:' || taken, 0));
        SELECT p.id INTO holder
          FROM people p
         WHERE p.workspace_id = NEW.workspace_id AND p.email_primary = taken AND p.id <> NEW.id
         LIMIT 1;
        IF holder IS NULL THEN
            SELECT pa.person_id INTO holder
              FROM person_addresses pa
             WHERE pa.workspace_id = NEW.workspace_id AND pa.address = taken AND pa.person_id <> NEW.id
             LIMIT 1;
        END IF;
        IF holder IS NOT NULL THEN
            RAISE EXCEPTION 'a person with the email % exists', taken
                USING ERRCODE = 'unique_violation', CONSTRAINT = 'people_address_taken';
        END IF;
    END LOOP;
    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION people_address_taken() FROM PUBLIC;

CREATE TRIGGER people_address_taken
    BEFORE INSERT OR UPDATE OF emails ON "people"
    FOR EACH ROW EXECUTE FUNCTION people_address_taken();
