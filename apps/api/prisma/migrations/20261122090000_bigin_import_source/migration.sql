-- BIGIN-1: a run reads Bigin's REST API or a backup export's CSV files. Schema only: every existing run read the API,
-- which the column's default says.
CREATE TYPE "bigin_import_source" AS ENUM ('api', 'export');

ALTER TABLE "bigin_import_runs" ADD COLUMN "source" "bigin_import_source" NOT NULL DEFAULT 'api';
