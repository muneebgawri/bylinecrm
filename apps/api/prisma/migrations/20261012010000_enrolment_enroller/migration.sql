-- #144: a sequence step's send belongs to the member who enrolled the person, not the pool
-- mailbox's owner. The enrolment records that member; existing enrolments and their sends are
-- backfilled from who enrolled them (a member actor, or an API key's creator).

ALTER TABLE "sequence_enrolments" ADD COLUMN "enrolled_by_member_id" UUID;

UPDATE "sequence_enrolments" e
SET "enrolled_by_member_id" = CASE
        WHEN e."enrolled_by"->>'kind' = 'member' THEN (e."enrolled_by"->>'id')::uuid
        WHEN e."enrolled_by"->>'kind' = 'api_key' THEN (SELECT k."created_by_id" FROM "api_keys" k WHERE k."id" = (e."enrolled_by"->>'id')::uuid)
    END;

-- A member actor that has since left the workspace cannot answer for the sends: fall back to the
-- sender the enrolment's sends already carry (the pool mailbox's owner, as P3-3 recorded them).
UPDATE "sequence_enrolments" e
SET "enrolled_by_member_id" = (
        SELECT o."sender_member_id" FROM "mail_outbound" o
        WHERE o."sequence_enrolment_id" = e."id" ORDER BY o."created_at" LIMIT 1)
WHERE e."enrolled_by_member_id" IS NULL
   OR NOT EXISTS (SELECT 1 FROM "workspace_members" m WHERE m."id" = e."enrolled_by_member_id");

-- Neither (no send yet, enroller gone): the workspace's longest-standing admin answers for it.
UPDATE "sequence_enrolments" e
SET "enrolled_by_member_id" = (
        SELECT m."id" FROM "workspace_members" m JOIN "roles" r ON r."id" = m."role_id"
        WHERE m."workspace_id" = e."workspace_id" AND r."is_system" AND r."name" = 'admin'
        ORDER BY m."created_at" LIMIT 1)
WHERE e."enrolled_by_member_id" IS NULL;

ALTER TABLE "sequence_enrolments" ALTER COLUMN "enrolled_by_member_id" SET NOT NULL;
ALTER TABLE "sequence_enrolments" ADD CONSTRAINT "sequence_enrolments_enrolled_by_member_id_fkey"
    FOREIGN KEY ("enrolled_by_member_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Each step's send: the enrolling member is its sender (the mailbox stays the pool mailbox).
UPDATE "mail_outbound" o
SET "sender_member_id" = e."enrolled_by_member_id"
FROM "sequence_enrolments" e
WHERE o."sequence_enrolment_id" = e."id" AND o."sender_member_id" <> e."enrolled_by_member_id";
