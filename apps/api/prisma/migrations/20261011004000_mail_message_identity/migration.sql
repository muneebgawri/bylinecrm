-- P2-2b (#107): one message per workspace, however many of its mailboxes hold it.
--
-- `mail_messages` was one row per mailbox copy, so mail between two connected mailboxes was stored twice.
-- It becomes the logical message (unique per workspace on `identity_key`); each mailbox's copy is a
-- `mail_message_copies` row; `mail_threads` becomes the logical conversation and each mailbox's Gmail
-- thread a `mailbox_threads` row. Existing duplicates are merged deterministically (the earliest stored
-- wins). docs/design-notes/P2-2b.md has the rules.

-- ── New tables ───────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "mailbox_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "provider_thread_id" TEXT NOT NULL,
    "thread_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mail_message_copies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "mailbox_thread_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "direction" "mail_direction" NOT NULL,
    "label_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_message_copies_pkey" PRIMARY KEY ("id")
);

-- ── Every old thread is its own mailbox's Gmail thread; every old message its own mailbox's copy ──

INSERT INTO "mailbox_threads" ("workspace_id", "mailbox_id", "provider_thread_id", "thread_id", "created_at")
SELECT t."workspace_id", t."mailbox_id", t."provider_thread_id", t."id", t."created_at"
FROM "mail_threads" t;

INSERT INTO "mail_message_copies"
    ("workspace_id", "message_id", "mailbox_id", "mailbox_thread_id", "provider_message_id", "direction", "label_ids", "created_at")
SELECT m."workspace_id", m."id", m."mailbox_id", mt."id", m."provider_message_id", m."direction", m."label_ids", m."created_at"
FROM "mail_messages" m
JOIN "mailbox_threads" mt ON mt."thread_id" = m."thread_id";

-- ── Identity, and the duplicates it reveals ─────────────────────────────────────────────────────

ALTER TABLE "mail_messages" ADD COLUMN "identity_key" TEXT;
UPDATE "mail_messages"
SET "identity_key" = COALESCE("rfc822_message_id", 'gmail:' || "mailbox_id" || ':' || "provider_message_id");

-- Each message → the message it merges into: the earliest stored of its (workspace, identity), then the smallest id.
-- A plain temporary table, dropped below: a Prisma migration is not guaranteed to be one transaction.
CREATE TEMP TABLE "p22b_merge" AS
SELECT m."id" AS "duplicate_id", k."id" AS "keeper_id", m."thread_id" AS "duplicate_thread_id", k."thread_id" AS "keeper_thread_id"
FROM "mail_messages" m
JOIN LATERAL (
    SELECT x."id", x."thread_id"
    FROM "mail_messages" x
    WHERE x."workspace_id" = m."workspace_id" AND x."identity_key" = m."identity_key"
    ORDER BY x."created_at", x."id"
    LIMIT 1
) k ON TRUE
WHERE k."id" <> m."id";

-- The keeper is outbound when any copy of it was (the workspace sent it).
UPDATE "mail_messages" k SET "direction" = 'outbound'
FROM "p22b_merge" d JOIN "mail_message_copies" c ON c."message_id" = d."duplicate_id"
WHERE k."id" = d."keeper_id" AND c."direction" = 'outbound';

-- Copies, sends and timeline entries move to the keeper.
UPDATE "mail_message_copies" c SET "message_id" = d."keeper_id"
FROM "p22b_merge" d WHERE c."message_id" = d."duplicate_id";

UPDATE "mail_outbound" o SET "mail_message_id" = d."keeper_id"
FROM "p22b_merge" d WHERE o."mail_message_id" = d."duplicate_id";

UPDATE "mail_outbound" o SET "reply_to_message_id" = d."keeper_id"
FROM "p22b_merge" d WHERE o."reply_to_message_id" = d."duplicate_id";

DELETE FROM "timeline_activities" t
USING "p22b_merge" d
WHERE t."linked_type" = 'email' AND t."linked_id" = d."duplicate_id"
  AND EXISTS (
      SELECT 1 FROM "timeline_activities" k
      WHERE k."workspace_id" = t."workspace_id" AND k."linked_type" = 'email' AND k."linked_id" = d."keeper_id"
        AND k."target_type" = t."target_type" AND k."target_id" = t."target_id"
  );

UPDATE "timeline_activities" t SET "linked_id" = d."keeper_id"
FROM "p22b_merge" d
WHERE t."linked_type" = 'email' AND t."linked_id" = d."duplicate_id";

-- A duplicate goes with its participants (the keeper has the same addresses).
DELETE FROM "mail_messages" m USING "p22b_merge" d WHERE m."id" = d."duplicate_id";

-- Threads joined by a duplicate are one conversation: each connected group of them becomes its earliest thread.
-- (Live sync never splits a conversation — a mailbox's second copy maps its Gmail thread to the message's
-- thread — but rows stored before this migration were threaded per mailbox.)
CREATE TEMP TABLE "p22b_thread_merge" AS
WITH RECURSIVE "edges" AS (
    SELECT "duplicate_thread_id" AS "a", "keeper_thread_id" AS "b" FROM "p22b_merge" WHERE "duplicate_thread_id" <> "keeper_thread_id"
    UNION
    SELECT "keeper_thread_id", "duplicate_thread_id" FROM "p22b_merge" WHERE "duplicate_thread_id" <> "keeper_thread_id"
), "reach" ("start", "node") AS (
    SELECT "a", "a" FROM "edges"
    UNION
    SELECT r."start", e."b" FROM "reach" r JOIN "edges" e ON e."a" = r."node"
)
SELECT DISTINCT ON (r."start") r."start" AS "thread_id", t."id" AS "canonical_id"
FROM "reach" r
JOIN "mail_threads" t ON t."id" = r."node"
ORDER BY r."start", t."created_at", t."id";

UPDATE "mail_messages" m SET "thread_id" = tm."canonical_id"
FROM "p22b_thread_merge" tm WHERE m."thread_id" = tm."thread_id" AND tm."thread_id" <> tm."canonical_id";

UPDATE "mailbox_threads" mt SET "thread_id" = tm."canonical_id"
FROM "p22b_thread_merge" tm WHERE mt."thread_id" = tm."thread_id" AND tm."thread_id" <> tm."canonical_id";

DELETE FROM "mail_threads" t
USING "p22b_thread_merge" tm
WHERE t."id" = tm."thread_id" AND tm."thread_id" <> tm."canonical_id";

DROP TABLE "p22b_thread_merge";

DROP TABLE "p22b_merge";

-- Counts, last message and subject from the rows (recountThread's rule).
UPDATE "mail_threads" t SET
    "message_count" = s."count",
    "last_message_at" = s."last_at",
    "subject" = COALESCE(s."first_subject", t."subject")
FROM (
    SELECT m."thread_id", count(*)::int AS "count", max(m."sent_at") AS "last_at",
           (array_agg(m."subject" ORDER BY m."sent_at", m."created_at", m."id"))[1] AS "first_subject"
    FROM "mail_messages" m
    GROUP BY m."thread_id"
) s
WHERE t."id" = s."thread_id";

-- ── The old columns go ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "mail_messages" DROP CONSTRAINT "mail_messages_mailbox_id_fkey";
ALTER TABLE "mail_threads" DROP CONSTRAINT "mail_threads_mailbox_id_fkey";
DROP INDEX "mail_messages_mailbox_id_provider_message_id_key";
DROP INDEX "mail_threads_mailbox_id_provider_thread_id_key";

ALTER TABLE "mail_messages" DROP COLUMN "label_ids",
DROP COLUMN "mailbox_id",
DROP COLUMN "provider_message_id",
ALTER COLUMN "identity_key" SET NOT NULL;

ALTER TABLE "mail_threads" DROP COLUMN "mailbox_id",
DROP COLUMN "provider_thread_id";

-- ── Keys ─────────────────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "mail_messages_workspace_id_identity_key_key" ON "mail_messages"("workspace_id", "identity_key");
CREATE UNIQUE INDEX "mailbox_threads_mailbox_id_provider_thread_id_key" ON "mailbox_threads"("mailbox_id", "provider_thread_id");
CREATE INDEX "mailbox_threads_thread_id_idx" ON "mailbox_threads"("thread_id");
CREATE UNIQUE INDEX "mail_message_copies_mailbox_id_provider_message_id_key" ON "mail_message_copies"("mailbox_id", "provider_message_id");
CREATE INDEX "mail_message_copies_message_id_idx" ON "mail_message_copies"("message_id");
CREATE INDEX "mail_message_copies_mailbox_thread_id_idx" ON "mail_message_copies"("mailbox_thread_id");

ALTER TABLE "mailbox_threads" ADD CONSTRAINT "mailbox_threads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mailbox_threads" ADD CONSTRAINT "mailbox_threads_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mailbox_threads" ADD CONSTRAINT "mailbox_threads_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mail_message_copies" ADD CONSTRAINT "mail_message_copies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_message_copies" ADD CONSTRAINT "mail_message_copies_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_message_copies" ADD CONSTRAINT "mail_message_copies_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mail_message_copies" ADD CONSTRAINT "mail_message_copies_mailbox_thread_id_fkey" FOREIGN KEY ("mailbox_thread_id") REFERENCES "mailbox_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security in P0-2's shape ───────────────────────────────────────────────────────────

ALTER TABLE "mailbox_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailbox_threads" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mailbox_threads"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- As mail_threads: written by sync, removed only by the blocklist purge; never edited.
GRANT SELECT, INSERT, DELETE ON "mailbox_threads" TO bylinecrm_app;

ALTER TABLE "mail_message_copies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_message_copies" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "mail_message_copies"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- As mail_messages: what the mailbox held, never edited; the blocklist purge removes.
GRANT SELECT, INSERT, DELETE ON "mail_message_copies" TO bylinecrm_app;
