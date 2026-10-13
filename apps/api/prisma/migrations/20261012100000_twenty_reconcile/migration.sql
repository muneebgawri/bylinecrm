-- #156 (D-252) The cutover reconciliation report: a reconcile run reads every id Twenty still returns and
-- flags the mapped records it no longer does as missing in source, for a person to review. Nothing is
-- deleted on its own; any run that sees the record again clears the flag.
ALTER TYPE "twenty_import_mode" ADD VALUE 'reconcile';
ALTER TABLE "twenty_import_links" ADD COLUMN "checked_at" TIMESTAMPTZ;
ALTER TABLE "twenty_import_links" ADD COLUMN "missing_since" TIMESTAMPTZ;
CREATE INDEX "twenty_import_links_workspace_id_missing_since_idx" ON "twenty_import_links"("workspace_id", "missing_since");
