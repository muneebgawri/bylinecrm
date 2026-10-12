-- #136: separate from the enum value it uses — Postgres refuses a new enum value before it is
-- committed (55P04), and each Prisma migration runs in one transaction.
-- Each kind's shape, now with the task step: a title and nothing else.
ALTER TABLE "sequence_steps" DROP CONSTRAINT "sequence_steps_shape";
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_shape" CHECK (
    ("kind" = 'email' AND "template_id" IS NOT NULL AND "wait_days" IS NULL AND "task_title" IS NULL)
    OR ("kind" = 'wait' AND "template_id" IS NULL AND NOT "reply_in_thread" AND "wait_days" BETWEEN 1 AND 90
        AND "task_title" IS NULL)
    OR ("kind" = 'task' AND "template_id" IS NULL AND NOT "reply_in_thread" AND "wait_days" IS NULL
        AND length(btrim("task_title")) BETWEEN 1 AND 200));
