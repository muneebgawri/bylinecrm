-- BIGIN-1: an importer carries entries over from another system's history (a Bigin export's stage moves and logged
-- emails) under its own `source` and key, so a re-run writes nothing twice. Such an entry keeps its own kind
-- (`deal.stage_changed`) and is the import's: a keyed entry is an integration's `external.` one, or an import's.
-- Schema only. The new check is weaker than the old, so every row meets it: added NOT VALID (no scan under the
-- table's lock), then validated, which reads the rows without blocking writes.
ALTER TABLE "timeline_activities" DROP CONSTRAINT "timeline_activities_external_kind";
ALTER TABLE "timeline_activities" ADD CONSTRAINT "timeline_activities_external_kind"
    CHECK (("source" IS NULL) OR ("kind" LIKE 'external.%') OR (("actor" ->> 'kind') = 'import')) NOT VALID;
ALTER TABLE "timeline_activities" VALIDATE CONSTRAINT "timeline_activities_external_kind";
