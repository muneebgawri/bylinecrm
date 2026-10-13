-- #158 A task a sequence step made remembers the step and the enrolment, so the enrolment view can
-- show it with its state. A member's task has neither. Removing the step or the enrolment keeps the task.
ALTER TABLE "tasks" ADD COLUMN "sequence_enrolment_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "sequence_step_id" UUID;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_enrolment_id_fkey" FOREIGN KEY ("sequence_enrolment_id") REFERENCES "sequence_enrolments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_step_id_fkey" FOREIGN KEY ("sequence_step_id") REFERENCES "sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tasks_sequence_enrolment_id_idx" ON "tasks"("sequence_enrolment_id");
