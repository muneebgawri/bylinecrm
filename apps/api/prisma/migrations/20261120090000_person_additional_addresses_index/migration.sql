-- ── Who an address belongs to, without reading every person ─────────────────────────────────────────────────────
-- Mail and calendar matching (`PERSON_FOR_ADDRESS`) asked, per address, for the person whose primary OR additional
-- email it is; the OR over a jsonb array read the whole people table each time (~0.4 s an address at 164k people,
-- 1.8M full reads by 2026-11-04), which starved the Bigin import's transactions. A person's additional addresses,
-- lower case, as one jsonb expression: a GIN index on it answers "who lists this address" from the index; the
-- primary address already has its unique index. Built-in operators only, so a table too small for the index is
-- still cheap to scan. (The build reads the table once, with nothing to rewrite; CONCURRENTLY cannot run inside a
-- migration.)
CREATE INDEX "people_additional_addresses_idx" ON "people"
    USING gin (((lower((("emails" -> 'additional'))::text))::jsonb) jsonb_path_ops);
