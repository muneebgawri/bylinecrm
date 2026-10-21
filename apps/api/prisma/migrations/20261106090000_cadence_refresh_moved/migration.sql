-- CADENCE-1: refresh_cadence reads the transfers that moved a batch's deals once, not once a deal. Under row-level
-- security the per-deal lookup could not use the index on `moved`, and a batch of 500 deals took ~18 s (over the
-- transaction's 15 s); now ~1.2 s, measured on production.
CREATE OR REPLACE FUNCTION refresh_cadence(p_ids uuid[])
    RETURNS integer
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    WITH deals AS (
        SELECT o."id", o."workspace_id", o."owner_id", o."point_of_contact_id" AS poc, o."company_id", o."created_at",
               o."next_follow_up_date", st."cadence_days", p."email_primary", p."contact_status", p."last_contacted_at",
               (o."deleted_at" IS NULL AND o."closed_at" IS NULL AND st."kind" = 'open' AND o."owner_id" IS NOT NULL
                AND st."cadence_days" IS NOT NULL) AS open_owned
        FROM "opportunities" o
        JOIN "pipeline_stages" st ON st."id" = o."stage_id"
        LEFT JOIN "people" p ON p."id" = o."point_of_contact_id"
        WHERE p_ids IS NULL OR o."id" = ANY (p_ids)
    ),
    -- The transfers that moved these deals, read once for the batch: a lookup per deal cannot use the index on
    -- `moved` under row-level security (`@>` is not leakproof), and scanned the owner's every transfer.
    moved AS MATERIALIZED (
        SELECT (e ->> 'id')::uuid AS "deal_id", t."to_member_id", max(t."decided_at") AS "decided_at"
        FROM "ownership_transfers" t
        CROSS JOIN LATERAL jsonb_array_elements(t."moved") e
        WHERE t."status" IN ('accepted', 'forced') AND e ->> 'type' = 'opportunity'
          AND (e ->> 'id') IN (SELECT dd."id"::text FROM deals dd)
        GROUP BY 1, 2
    ),
    facts AS (
        SELECT d."id", d."cadence_days", d."next_follow_up_date",
            (d.open_owned
             AND coalesce(d."contact_status" NOT IN ('customer', 'do_not_contact'), true)
             AND NOT EXISTS (
                 SELECT 1 FROM "opportunities" w JOIN "pipeline_stages" ws ON ws."id" = w."stage_id"
                 WHERE d."company_id" IS NOT NULL AND w."company_id" = d."company_id" AND w."deleted_at" IS NULL
                   AND ws."kind" = 'won'
             )
             AND NOT EXISTS (
                 SELECT 1 FROM "outreach_exclusions" x
                 WHERE x."workspace_id" = d."workspace_id" AND x."removed_at" IS NULL
                   AND ((d."email_primary" IS NOT NULL
                         AND (x."address" = d."email_primary" OR x."domain" = split_part(d."email_primary", '@', 2)))
                        OR (x."domain" IS NOT NULL
                            AND x."domain" = (SELECT lower(c."domain") FROM "companies" c WHERE c."id" = d."company_id")))
             )) AS in_scope,
            GREATEST(
                d."created_at",
                (SELECT max(mv."decided_at") FROM moved mv
                 WHERE mv."deal_id" = d."id" AND mv."to_member_id" = d."owner_id"),
                d."last_contacted_at",
                (SELECT max(m."sent_at") FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                 WHERE mp."workspace_id" = d."workspace_id" AND mp."person_id" = d.poc AND m."direction" = 'inbound' AND mp."role" = 'from'),
                (SELECT max(n."created_at") FROM "note_targets" nt JOIN "notes" n ON n."id" = nt."note_id"
                 WHERE nt."workspace_id" = d."workspace_id" AND n."deleted_at" IS NULL
                   AND ((nt."target_type" = 'opportunity' AND nt."target_id" = d."id")
                        OR (nt."target_type" = 'person' AND nt."target_id" = d.poc))),
                (SELECT max(k."completed_at") FROM "task_targets" kt JOIN "tasks" k ON k."id" = kt."task_id"
                 WHERE kt."workspace_id" = d."workspace_id" AND k."deleted_at" IS NULL
                   AND ((kt."target_type" = 'opportunity' AND kt."target_id" = d."id")
                        OR (kt."target_type" = 'person' AND kt."target_id" = d.poc))),
                (SELECT max(e."starts_at") FROM "calendar_event_participants" cp
                 JOIN "calendar_events" e ON e."id" = cp."event_id"
                 WHERE cp."workspace_id" = d."workspace_id" AND cp."person_id" = d.poc AND e."status" <> 'cancelled' AND e."starts_at" <= now()),
                (SELECT max(h."entered_at") FROM "opportunity_stage_history" h
                 WHERE h."workspace_id" = d."workspace_id" AND h."opportunity_id" = d."id" AND h."actor" ->> 'kind' = 'member'
                   AND h."actor" ->> 'id' = d."owner_id"::text)
            ) AS touched
        FROM deals d
    ),
    derived AS (
        SELECT f."id", (CASE WHEN f.in_scope THEN f.touched END) AS touched,
            (CASE WHEN f.in_scope THEN GREATEST(
                f.touched + make_interval(days => f."cadence_days"),
                CASE WHEN f."next_follow_up_date" IS NOT NULL THEN LEAST(
                    (f."next_follow_up_date"::timestamp AT TIME ZONE 'UTC') + interval '1 day',
                    f.touched + interval '14 days')
                END)
            END) AS due
        FROM facts f
    ),
    updated AS (
        UPDATE "opportunities" o
        SET "cadence_touched_at" = d.touched, "cadence_due_at" = d.due,
            "cadence_overdue" = coalesce(d.due <= now(), false)
        FROM derived d
        WHERE o."id" = d."id"
          AND (o."cadence_touched_at", o."cadence_due_at", o."cadence_overdue")
              IS DISTINCT FROM (d.touched, d.due, coalesce(d.due <= now(), false))
        RETURNING o."id"
    )
    SELECT count(*) INTO changed FROM updated;

    UPDATE "people" p
    SET "cadence_overdue" = EXISTS (
        SELECT 1 FROM "opportunities" o
        WHERE o."point_of_contact_id" = p."id" AND o."deleted_at" IS NULL AND o."cadence_overdue")
    WHERE (p_ids IS NULL OR p."id" IN (SELECT o."point_of_contact_id" FROM "opportunities" o WHERE o."id" = ANY (p_ids)))
      AND p."cadence_overdue" IS DISTINCT FROM EXISTS (
        SELECT 1 FROM "opportunities" o
        WHERE o."point_of_contact_id" = p."id" AND o."deleted_at" IS NULL AND o."cadence_overdue");
    RETURN changed;
END
$$;

