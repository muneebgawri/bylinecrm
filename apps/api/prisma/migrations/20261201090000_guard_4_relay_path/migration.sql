-- GUARD-4: the outbound relay's events. Expand only: one guardrail path, no table change, no backfill.

ALTER TYPE "guardrail_path" ADD VALUE IF NOT EXISTS 'relay';
