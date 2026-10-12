-- #136: a sequence step may create a task on the person (doc 50 §D "Call if no reply → owner").
ALTER TYPE "sequence_step_kind" ADD VALUE 'task';

ALTER TABLE "sequence_steps" ADD COLUMN "task_title" TEXT;

