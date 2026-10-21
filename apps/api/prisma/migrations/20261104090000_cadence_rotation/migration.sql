-- CADENCE-1: a follow-up cadence per open stage, the overdue flag on deals and people, the rotation's settings and
-- members, and one row per lapse (warned once, rotated once). docs/design-notes/CADENCE-1.md.

-- ── Cadence per stage ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "pipeline_stages" ADD COLUMN "cadence_days" INTEGER;
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_cadence_days_check"
    CHECK ("cadence_days" IS NULL OR "cadence_days" BETWEEN 1 AND 365);

-- The owner's defaults by stage name (`defaultCadenceDays` in @bylinecrm/shared); any other open stage 3; closed none.
UPDATE "pipeline_stages" SET "cadence_days" = (CASE lower(btrim("name"))
        WHEN 'new opportunity' THEN 1
        WHEN 'new' THEN 1
        WHEN 'proposal sent' THEN 5
        ELSE 3
    END)
WHERE "kind" = 'open';

-- ── The overdue flag ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "opportunities"
    ADD COLUMN "cadence_touched_at" TIMESTAMPTZ,
    ADD COLUMN "cadence_due_at" TIMESTAMPTZ,
    ADD COLUMN "cadence_overdue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "people" ADD COLUMN "cadence_overdue" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "opportunities_workspace_id_cadence_overdue_idx" ON "opportunities"("workspace_id", "cadence_overdue");
CREATE INDEX "people_workspace_id_cadence_overdue_idx" ON "people"("workspace_id", "cadence_overdue");

-- ── Rotation settings and members ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "rotation_settings" (
    "workspace_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_at" TIMESTAMPTZ,
    "warn_after_days" INTEGER NOT NULL DEFAULT 0,
    "grace_days" INTEGER NOT NULL DEFAULT 7,
    "intake_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mailbox_preference" TEXT NOT NULL DEFAULT 'prefer',
    "open_lead_cap" INTEGER,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rotation_settings_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "rotation_settings_warn_check" CHECK ("warn_after_days" BETWEEN 0 AND 90),
    CONSTRAINT "rotation_settings_grace_check" CHECK ("grace_days" BETWEEN 1 AND 90),
    CONSTRAINT "rotation_settings_cap_check" CHECK ("open_lead_cap" IS NULL OR "open_lead_cap" >= 1),
    CONSTRAINT "rotation_settings_mailbox_check" CHECK ("mailbox_preference" IN ('prefer', 'require', 'ignore')),
    CONSTRAINT "rotation_settings_enabled_at_check" CHECK (NOT "enabled" OR "enabled_at" IS NOT NULL)
);

CREATE TABLE "rotation_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "included" BOOLEAN,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "resume_at" TIMESTAMPTZ,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rotation_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rotation_members_weight_check" CHECK ("weight" BETWEEN 1 AND 5),
    CONSTRAINT "rotation_members_resume_check" CHECK ("paused" OR "resume_at" IS NULL)
);
CREATE UNIQUE INDEX "rotation_members_member_id_key" ON "rotation_members"("member_id");
CREATE INDEX "rotation_members_workspace_id_idx" ON "rotation_members"("workspace_id");

-- ── Lapses ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "cadence_lapses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "owner_member_id" UUID NOT NULL,
    "stage_name" TEXT NOT NULL,
    "cadence_days" INTEGER NOT NULL,
    "last_touch_at" TIMESTAMPTZ NOT NULL,
    "due_at" TIMESTAMPTZ NOT NULL,
    "warned_at" TIMESTAMPTZ NOT NULL,
    "rotate_at" TIMESTAMPTZ NOT NULL,
    "resolved_at" TIMESTAMPTZ,
    "resolution" TEXT,
    "transfer_id" UUID,
    "blocked_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cadence_lapses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cadence_lapses_resolution_check" CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL)
        AND ("resolution" IS NULL OR "resolution" IN ('touched', 'closed', 'owner_changed', 'out_of_scope', 'rotated'))),
    CONSTRAINT "cadence_lapses_rotated_check" CHECK ("resolution" = 'rotated' OR "transfer_id" IS NULL)
);
-- One open lapse per deal: what makes the hourly job warn once per lapse and rotate once.
CREATE UNIQUE INDEX "cadence_lapses_open_key" ON "cadence_lapses"("opportunity_id") WHERE "resolved_at" IS NULL;
CREATE INDEX "cadence_lapses_workspace_id_rotate_at_idx" ON "cadence_lapses"("workspace_id", "rotate_at");
CREATE INDEX "cadence_lapses_opportunity_id_idx" ON "cadence_lapses"("opportunity_id");

ALTER TABLE "rotation_settings" ADD CONSTRAINT "rotation_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rotation_members" ADD CONSTRAINT "rotation_members_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rotation_members" ADD CONSTRAINT "rotation_members_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cadence_lapses" ADD CONSTRAINT "cadence_lapses_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cadence_lapses" ADD CONSTRAINT "cadence_lapses_opportunity_id_fkey"
    FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cadence_lapses" ADD CONSTRAINT "cadence_lapses_owner_member_id_fkey"
    FOREIGN KEY ("owner_member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cadence_lapses" ADD CONSTRAINT "cadence_lapses_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "ownership_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, as every tenant table.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['rotation_settings', 'rotation_members', 'cadence_lapses'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY workspace_isolation ON %I FOR ALL TO bylinecrm_app '
            'USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO bylinecrm_app', t);
    END LOOP;
END
$$;

-- ── Notifications ────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'cadence_warning';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'cadence_rotated';
ALTER TABLE "notifications" ADD COLUMN "cadence_lapse_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cadence_lapse_id_fkey"
    FOREIGN KEY ("cadence_lapse_id") REFERENCES "cadence_lapses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "notifications_member_id_kind_cadence_lapse_id_key"
    ON "notifications"("member_id", "kind", "cadence_lapse_id");
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing"
    CHECK (num_nonnulls("task_id", "transfer_id", "guardrail_event_id", "invoice_id", "cadence_lapse_id") = 1);

-- ── The permission ───────────────────────────────────────────────────────────────────────────────────────────────
-- The `manager` system role edits cadences and the rotation (admins hold every capability by construction).
INSERT INTO "role_permissions" ("id", "workspace_id", "role_id", "capability")
SELECT gen_random_uuid(), r."workspace_id", r."id", 'pipeline:cadence'
FROM "roles" r
WHERE r."name" = 'manager' AND r."is_system"
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role_id" = r."id" AND p."capability" = 'pipeline:cadence');

-- ── The one definition of a lead's cadence ───────────────────────────────────────────────────────────────────────
-- Derives `cadence_due_at` and `cadence_overdue` for the given deals (every visible deal when `p_ids` is null), and
-- the overdue flag of their contacts; returns how many deals changed. A deal is in scope when it is open, owned, in a
-- stage with a cadence, and its contact is no customer, not suppressed and not excluded from outreach. Its last
-- touch is the latest of: created, received by its owner, mail to or from its contact, a note on it or its contact, a
-- task on either completed, a meeting with its contact that has started, a stage move by its owner. Due is the last
-- touch plus the cadence; a planned follow-up defers it, at most 14 days past the touch. SECURITY INVOKER: run by
-- the app role, row-level security keeps it to the current workspace. It writes no `updated_at`.
CREATE FUNCTION refresh_cadence(p_ids uuid[])
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
                (SELECT max(t."decided_at") FROM "ownership_transfers" t
                 WHERE t."workspace_id" = d."workspace_id" AND t."to_member_id" = d."owner_id"
                   AND t."status" IN ('accepted', 'forced')
                   AND t."moved" @> jsonb_build_array(jsonb_build_object('type', 'opportunity', 'id', d."id"::text))),
                d."last_contacted_at",
                (SELECT max(m."sent_at") FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                 WHERE mp."person_id" = d.poc AND m."direction" = 'inbound' AND mp."role" = 'from'),
                (SELECT max(n."created_at") FROM "note_targets" nt JOIN "notes" n ON n."id" = nt."note_id"
                 WHERE n."deleted_at" IS NULL
                   AND ((nt."target_type" = 'opportunity' AND nt."target_id" = d."id")
                        OR (nt."target_type" = 'person' AND nt."target_id" = d.poc))),
                (SELECT max(k."completed_at") FROM "task_targets" kt JOIN "tasks" k ON k."id" = kt."task_id"
                 WHERE k."deleted_at" IS NULL
                   AND ((kt."target_type" = 'opportunity' AND kt."target_id" = d."id")
                        OR (kt."target_type" = 'person' AND kt."target_id" = d.poc))),
                (SELECT max(e."starts_at") FROM "calendar_event_participants" cp
                 JOIN "calendar_events" e ON e."id" = cp."event_id"
                 WHERE cp."person_id" = d.poc AND e."status" <> 'cancelled' AND e."starts_at" <= now()),
                (SELECT max(h."entered_at") FROM "opportunity_stage_history" h
                 WHERE h."opportunity_id" = d."id" AND h."actor" ->> 'kind' = 'member'
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

REVOKE ALL ON FUNCTION refresh_cadence(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_cadence(uuid[]) TO bylinecrm_app;

-- Every deal's cadence from what is on record (the owner role is not held to row-level security).
SELECT refresh_cadence(NULL);
