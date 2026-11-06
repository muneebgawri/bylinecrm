-- Contact attempts count the emails an import carried over (`external.email` entries on the person: the follow-ups
-- sent from another system), as well as outbound mail. An entry whose status says it never went (Failed, Pending)
-- is no attempt; nor is one the synced mailbox holds too — an outbound message to the person with the same subject
-- (case and surrounding space aside) sent within ten minutes of it. `last_contacted_at` is the later of the two.
--
-- Schema only: the function is replaced, no row is re-derived here (a full-table refresh in a migration holds
-- `people` for its length). After deploy, `node dist/cli/refresh-contact-status.js` re-derives every person a
-- batch at a time.
--
-- The external entries are found by the timeline's (workspace_id, target_id, …) index: under row-level security
-- only leakproof conditions (uuid equality) may use it; the kind, status and subject tests filter what it found.
CREATE OR REPLACE FUNCTION refresh_contact_status(p_person_ids uuid[])
    RETURNS integer
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    WITH facts AS (
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
            sent.attempts + ext.attempts AS attempts,
            greatest(sent.last_at, ext.last_at) AS last_at,
            (
                SELECT count(DISTINCT m."id") FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                WHERE mp."person_id" = p."id" AND m."direction" = 'inbound' AND mp."role" = 'from'
            )::integer AS replies,
            EXISTS (
                SELECT 1 FROM "calendar_event_participants" cp JOIN "calendar_events" e ON e."id" = cp."event_id"
                WHERE cp."person_id" = p."id" AND e."status" <> 'cancelled'
            ) AS met
        FROM "people" p
        CROSS JOIN LATERAL (
            SELECT count(DISTINCT m."id")::integer AS attempts, max(m."sent_at") AS last_at
            FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
            WHERE mp."person_id" = p."id" AND m."direction" = 'outbound' AND mp."role" IN ('to', 'cc', 'bcc')
        ) sent
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
