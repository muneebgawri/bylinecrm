-- GUARD-1b (#202, FR-CRMS-21): a CSV export is kept in `guardrail_events` (kind `record_export`, path `export`):
-- who exported which object, under which filter, how many rows, and whether only their own records.
ALTER TYPE "guardrail_kind" ADD VALUE 'record_export';
ALTER TYPE "guardrail_path" ADD VALUE 'export';
