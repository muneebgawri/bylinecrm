-- ── Lookups by record, answered by an index under row-level security ────────────────────────────────────────────
-- The app role's row-level security lets Postgres use an index only for a leakproof condition, and enum equality
-- (`enum_eq`: target_type, object, linked_type) is not leakproof; uuid and timestamp comparisons are. So an index
-- keyed (workspace, type, id) was read by workspace alone — every lookup of one record's timeline scanned the
-- workspace's whole range (~95 ms at 1.45M entries; the Bigin import's chunks ran past their 15 s transaction).
-- Each index keeps its columns, the id now before the type: the workspace and id narrow it to the record, the
-- type is checked on those few rows. Unique keys are untouched (their order serves conflict checks, not lookups).
-- Schema only. A plain build reads each table once and holds off writes to it while it does (seconds);
-- CONCURRENTLY cannot run inside a migration.
DROP INDEX "timeline_activities_workspace_id_target_type_target_id_happ_idx";
CREATE INDEX "timeline_activities_record_idx" ON "timeline_activities"("workspace_id", "target_id", "target_type", "happened_at" DESC);
DROP INDEX "timeline_activities_workspace_id_linked_type_linked_id_idx";
CREATE INDEX "timeline_activities_linked_idx" ON "timeline_activities"("workspace_id", "linked_id", "linked_type");

DROP INDEX "note_targets_workspace_id_target_type_target_id_idx";
CREATE INDEX "note_targets_record_idx" ON "note_targets"("workspace_id", "target_id", "target_type");

DROP INDEX "task_targets_workspace_id_target_type_target_id_idx";
CREATE INDEX "task_targets_record_idx" ON "task_targets"("workspace_id", "target_id", "target_type");

DROP INDEX "attachments_workspace_id_target_type_target_id_idx";
CREATE INDEX "attachments_record_idx" ON "attachments"("workspace_id", "target_id", "target_type");

DROP INDEX "ownership_transfers_workspace_id_object_record_id_created_a_idx";
CREATE INDEX "ownership_transfers_record_idx" ON "ownership_transfers"("workspace_id", "record_id", "object", "created_at" DESC);

DROP INDEX "enrichment_answers_workspace_id_object_record_id_asked_at_idx";
CREATE INDEX "enrichment_answers_record_idx" ON "enrichment_answers"("workspace_id", "record_id", "object", "asked_at" DESC);
