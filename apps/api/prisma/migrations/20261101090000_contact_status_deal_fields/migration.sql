-- #242: contact status on people, follow-up fields and a lost-reason picklist on deals, and won deals as customers.

-- ── Contact status (people) ──────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "contact_status" AS ENUM (
    'new', 'attempted_contact', 'contacted', 'engaged', 'unresponsive', 'do_not_contact', 'customer'
);

ALTER TABLE "people"
    ADD COLUMN "contact_status" "contact_status" NOT NULL DEFAULT 'new',
    ADD COLUMN "contact_status_override" "contact_status",
    ADD COLUMN "contact_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "last_contacted_at" TIMESTAMPTZ;

-- Do Not Contact is the suppression list, never a second copy of it.
ALTER TABLE "people" ADD CONSTRAINT "people_contact_status_override_check"
    CHECK ("contact_status_override" IS DISTINCT FROM 'do_not_contact');
ALTER TABLE "people" ADD CONSTRAINT "people_contact_attempts_check" CHECK ("contact_attempts" >= 0);

CREATE INDEX "people_workspace_id_contact_status_idx" ON "people"("workspace_id", "contact_status");

-- Derives `contact_status`, `contact_attempts` and `last_contacted_at` for the given people (every visible person
-- when `p_person_ids` is null) and writes the rows that changed; returns how many. The one definition of the rules
-- `CONTACT_STATUSES` in @bylinecrm/shared describes: the API calls it when something a status reads changes, the
-- backfill CLI calls it for a whole workspace. SECURITY INVOKER: run by the app role, row-level security keeps it to
-- the current workspace. It writes no `updated_at`: a derived change is not an edit.
CREATE FUNCTION refresh_contact_status(p_person_ids uuid[])
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
            (
                SELECT count(DISTINCT m."id") FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                WHERE mp."person_id" = p."id" AND m."direction" = 'outbound' AND mp."role" IN ('to', 'cc', 'bcc')
            )::integer AS attempts,
            (
                SELECT max(m."sent_at") FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                WHERE mp."person_id" = p."id" AND m."direction" = 'outbound' AND mp."role" IN ('to', 'cc', 'bcc')
            ) AS last_at,
            (
                SELECT count(DISTINCT m."id") FROM "mail_participants" mp JOIN "mail_messages" m ON m."id" = mp."message_id"
                WHERE mp."person_id" = p."id" AND m."direction" = 'inbound' AND mp."role" = 'from'
            )::integer AS replies,
            EXISTS (
                SELECT 1 FROM "calendar_event_participants" cp JOIN "calendar_events" e ON e."id" = cp."event_id"
                WHERE cp."person_id" = p."id" AND e."status" <> 'cancelled'
            ) AS met
        FROM "people" p
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

REVOKE ALL ON FUNCTION refresh_contact_status(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_contact_status(uuid[]) TO bylinecrm_app;

-- ── Deal fields ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "lost_reason_code" AS ENUM (
    'price_budget', 'no_response', 'chose_competitor', 'not_ready', 'service_not_suitable', 'timing',
    'duplicate_opportunity', 'other'
);

ALTER TABLE "opportunities"
    ADD COLUMN "lost_reason_code" "lost_reason_code",
    ADD COLUMN "next_follow_up_date" DATE,
    ADD COLUMN "follow_up_task_id" UUID,
    ADD COLUMN "next_activity" TEXT,
    ADD COLUMN "service_interest" TEXT,
    ADD COLUMN "lead_source" TEXT;

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_follow_up_task_id_fkey"
    FOREIGN KEY ("follow_up_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deals already lost get a picklist reason: the one their free text names, else `other` (DEFAULT_LOST_REASON).
UPDATE "opportunities" o
SET "lost_reason_code" = (CASE
        WHEN lower(coalesce(o."lost_reason", '')) ~ 'duplicate' THEN 'duplicate_opportunity'
        WHEN lower(coalesce(o."lost_reason", '')) ~ '(price|pricing|budget|cost|expensive)' THEN 'price_budget'
        WHEN lower(coalesce(o."lost_reason", '')) ~ '(no[ _-]?response|no[ _-]?reply|unresponsive|ghosted|no[ _-]?answer)' THEN 'no_response'
        WHEN lower(coalesce(o."lost_reason", '')) ~ '(competitor|competition)' THEN 'chose_competitor'
        WHEN lower(coalesce(o."lost_reason", '')) ~ 'not[ _-]?ready' THEN 'not_ready'
        WHEN lower(coalesce(o."lost_reason", '')) ~ '(not suitable|not a fit|unsuitable)' THEN 'service_not_suitable'
        WHEN lower(coalesce(o."lost_reason", '')) ~ 'timing' THEN 'timing'
        ELSE 'other'
    END)::"lost_reason_code"
FROM "pipeline_stages" st
WHERE st."id" = o."stage_id" AND st."kind" = 'lost';

-- ── Won deals as customers ───────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "outreach_exclusions"
    ADD COLUMN "review_reason" TEXT,
    ADD COLUMN "review_flagged_at" TIMESTAMPTZ;
ALTER TABLE "outreach_exclusions" ADD CONSTRAINT "outreach_exclusions_review_check"
    CHECK (("review_reason" IS NULL) = ("review_flagged_at" IS NULL)
           AND ("review_reason" IS NULL OR "review_reason" IN ('deal_reopened', 'deal_refunded')));

CREATE INDEX "outreach_exclusions_workspace_id_source_external_ref_idx"
    ON "outreach_exclusions"("workspace_id", "source", "external_ref");

CREATE TABLE "customer_exclusion_settings" (
    "workspace_id" UUID NOT NULL,
    "won_exclusion_scope" TEXT NOT NULL DEFAULT 'address',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customer_exclusion_settings_pkey" PRIMARY KEY ("workspace_id"),
    CONSTRAINT "customer_exclusion_settings_scope_check" CHECK ("won_exclusion_scope" IN ('address', 'domain'))
);

ALTER TABLE "customer_exclusion_settings" ADD CONSTRAINT "customer_exclusion_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_exclusion_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_exclusion_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "customer_exclusion_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_exclusion_settings" TO bylinecrm_app;

-- Every person's status, attempts and last contact, from what is already on record. Run as the migration's owner,
-- which row-level security does not restrict, so it covers every workspace.
SELECT refresh_contact_status(NULL);
