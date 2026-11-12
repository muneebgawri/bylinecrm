-- `refresh_contact_status()` re-derives the same facts as before, computed once per person. The `facts` CTE was
-- inlined into the UPDATE, so every reference to a derived column (the status CASE, the attempts, the IS DISTINCT
-- FROM test) re-ran its correlated subqueries: three to five passes over a person's mail per refresh. The mail
-- history backfill refreshes the people of each chunk inside one transaction, and a chunk of frequent
-- correspondents overran it (15 s). Now `facts` is MATERIALIZED (evaluated once) and a person's mail is read in one
-- pass: outbound attempts, their last time and inbound replies come from the same scan, by filtered aggregates.
--
-- Schema only: the rules are unchanged, so no row is re-derived here.
CREATE OR REPLACE FUNCTION refresh_contact_status(p_person_ids uuid[])
    RETURNS integer
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    WITH facts AS MATERIALIZED (
        SELECT
            p."id",
            p."contact_status_override" AS override,
            EXISTS (
                SELECT 1 FROM "suppressions" s
                WHERE s."workspace_id" = p."workspace_id" AND s."removed_at" IS NULL AND s."address" = p."email_primary"
            ) AS suppressed,
            EXISTS (
                SELECT 1 FROM "opportunities" o JOIN "pipeline_stages" st ON st."id" = o."stage_id"
                WHERE o."point_of_contact_id" = p."id" AND o."deleted_at" IS NULL AND st."kind" = 'won'
            ) AS customer,
            mail.attempts + ext.attempts AS attempts,
            greatest(mail.last_at, ext.last_at) AS last_at,
            mail.replies AS replies,
            EXISTS (
                SELECT 1 FROM "calendar_event_participants" cp JOIN "calendar_events" e ON e."id" = cp."event_id"
                WHERE cp."person_id" = p."id" AND e."status" <> 'cancelled'
            ) AS met
        FROM "people" p
        CROSS JOIN LATERAL (
            SELECT
                count(DISTINCT m."id") FILTER (WHERE m."direction" = 'outbound' AND mp."role" IN ('to', 'cc', 'bcc'))::integer
                    AS attempts,
                max(m."sent_at") FILTER (WHERE m."direction" = 'outbound' AND mp."role" IN ('to', 'cc', 'bcc')) AS last_at,
                count(DISTINCT m."id") FILTER (WHERE m."direction" = 'inbound' AND mp."role" = 'from')::integer AS replies
            FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
            WHERE mp."person_id" = p."id"
        ) mail
        CROSS JOIN LATERAL (
            SELECT count(*)::integer AS attempts, max(t."happened_at") AS last_at
            FROM "timeline_activities" t
            WHERE t."workspace_id" = p."workspace_id" AND t."target_id" = p."id"
              AND t."target_type" = 'person' AND t."kind" = 'external.email'
              AND coalesce(t."properties" -> 'email' ->> 'status', '') NOT IN ('Failed', 'Pending')
              AND NOT EXISTS (
                  SELECT 1 FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                  WHERE mp."workspace_id" = p."workspace_id" AND mp."person_id" = p."id"
                    AND m."direction" = 'outbound' AND mp."role" IN ('to', 'cc', 'bcc')
                    AND m."sent_at" >= t."happened_at" - interval '10 minutes'
                    AND m."sent_at" <= t."happened_at" + interval '10 minutes'
                    AND lower(btrim(m."subject")) = lower(btrim(coalesce(t."properties" -> 'email' ->> 'subject', '')))
              )
        ) ext
        WHERE p_person_ids IS NULL OR p."id" = ANY (p_person_ids)
    ),
    derived AS (
        SELECT
            f."id",
            f.attempts,
            f.last_at,
            (CASE
                WHEN f.suppressed THEN 'do_not_contact'
                WHEN f.override IS NOT NULL THEN f.override::text
                WHEN f.customer THEN 'customer'
                WHEN f.replies >= 2 OR f.met THEN 'engaged'
                WHEN f.replies = 1 THEN 'contacted'
                WHEN f.attempts >= 3 THEN 'unresponsive'
                WHEN f.attempts >= 1 THEN 'attempted_contact'
                ELSE 'new'
            END)::"contact_status" AS status
        FROM facts f
    )
    UPDATE "people" p
    SET "contact_status" = d.status, "contact_attempts" = d.attempts, "last_contacted_at" = d.last_at
    FROM derived d
    WHERE p."id" = d."id"
      AND (p."contact_status", p."contact_attempts", p."last_contacted_at")
          IS DISTINCT FROM (d.status, d.attempts, d.last_at);
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END
$$;
