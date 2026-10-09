-- P1-2b: a stage can be deleted by moving its deals, and history must survive it.
--
-- 1. A new history reason: the deal moved because the stage it was in was deleted. Only added
--    here; first used by application code after this migration commits.
ALTER TYPE "stage_history_reason" ADD VALUE IF NOT EXISTS 'stage_deleted';

-- 2. History is an audit log: it records where a deal was, including in stages that no longer
--    exist. Until now its stage columns were foreign keys with ON DELETE RESTRICT, so a stage that
--    had EVER held a deal could never be deleted (a latent defect: deleting it answered 500). Each
--    row now carries the stage names it recorded, and keeps the ids without pinning the stage
--    configuration in place. Ids are written only by the one move service, from stages it has just
--    read in the same transaction.
ALTER TABLE "opportunity_stage_history" ADD COLUMN "from_stage_name" TEXT;
ALTER TABLE "opportunity_stage_history" ADD COLUMN "to_stage_name" TEXT;

UPDATE "opportunity_stage_history" h
   SET "to_stage_name" = s."name"
  FROM "pipeline_stages" s
 WHERE s."id" = h."to_stage_id";
UPDATE "opportunity_stage_history" h
   SET "from_stage_name" = s."name"
  FROM "pipeline_stages" s
 WHERE s."id" = h."from_stage_id";

ALTER TABLE "opportunity_stage_history" ALTER COLUMN "to_stage_name" SET NOT NULL;

ALTER TABLE "opportunity_stage_history" DROP CONSTRAINT "opportunity_stage_history_from_stage_id_fkey";
ALTER TABLE "opportunity_stage_history" DROP CONSTRAINT "opportunity_stage_history_to_stage_id_fkey";
