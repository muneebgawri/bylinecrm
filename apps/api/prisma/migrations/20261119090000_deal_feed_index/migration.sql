-- ── The live deal feed ───────────────────────────────────────────────────────────────────────────────────────────
-- The feed reads a workspace's newest deal entries that people and rules wrote (an import's or a sync's are left out),
-- polled by every open dashboard: a partial index of only those rows (a few hundred today), newest first.
-- (CONCURRENTLY cannot run inside a migration; the build reads the table once, with nothing to rewrite.)
CREATE INDEX "timeline_activities_deal_feed_idx" ON "timeline_activities"("workspace_id", "happened_at" DESC)
WHERE "target_type" = 'opportunity'
  AND "kind" IN ('opportunity.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'linked-invoice.verified')
  AND ("actor" ->> 'kind') IN ('member', 'api_key', 'rule');
