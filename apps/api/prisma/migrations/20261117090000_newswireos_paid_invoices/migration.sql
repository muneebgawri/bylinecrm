-- INV-2: a paid invoice NewswireOS reports goes on its deal, as an Account Manager would enter it.
-- Expand only: a new table, a nullable notification column, and a column with a constant default (no rewrite,
-- no backfill), so the colour still serving keeps working against this schema.

-- ── What a reported payment did ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "newswireos_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "payment_method" TEXT,
    "amount_minor" BIGINT,
    "currency" TEXT,
    "client_name" TEXT,
    "client_email" TEXT,
    "named_opportunity_id" TEXT,
    "target_type" TEXT,
    "target_id" UUID,
    "mode" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "matched_by" TEXT,
    "opportunity_id" UUID,
    "candidate_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "resolved_at" TIMESTAMPTZ,
    "resolved_by_id" UUID,
    "occurred_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newswireos_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "newswireos_payments_mode_check" CHECK ("mode" IN ('off', 'shadow', 'on')),
    CONSTRAINT "newswireos_payments_decision_check"
        CHECK ("decision" IN ('already_on_deal', 'attached', 'created_deal', 'needs_deal', 'unmatched')),
    CONSTRAINT "newswireos_payments_matched_by_check" CHECK ("matched_by" IN ('deal_id', 'only_open_deal'))
);

CREATE UNIQUE INDEX "newswireos_payments_workspace_id_invoice_number_key"
    ON "newswireos_payments"("workspace_id", "invoice_number");
CREATE INDEX "newswireos_payments_workspace_id_created_at_idx" ON "newswireos_payments"("workspace_id", "created_at");

ALTER TABLE "newswireos_payments" ADD CONSTRAINT "newswireos_payments_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "newswireos_payments" ADD CONSTRAINT "newswireos_payments_opportunity_id_fkey"
    FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "newswireos_payments" ADD CONSTRAINT "newswireos_payments_resolved_by_id_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, as every tenant table.
ALTER TABLE "newswireos_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "newswireos_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "newswireos_payments" FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "newswireos_payments" TO bylinecrm_app;

-- ── The switch ───────────────────────────────────────────────────────────────────────────────────────────────────
-- Every workspace starts in shadow: it records which deal each payment would go on, and acts on none.
ALTER TABLE "newswireos_settings" ADD COLUMN "payment_mode" TEXT NOT NULL DEFAULT 'shadow';
ALTER TABLE "newswireos_settings" ADD CONSTRAINT "newswireos_settings_payment_mode_check"
    CHECK ("payment_mode" IN ('off', 'shadow', 'on'));
-- Where Account Managers raise an invoice for a deal: the NewswireOS dashboard's workspace address.
ALTER TABLE "newswireos_settings" ADD COLUMN "dashboard_url" TEXT;

-- ── Notifications ────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'payment_needs_deal';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'payment_created_deal';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'payment_unmatched';

ALTER TABLE "notifications" ADD COLUMN "newswireos_payment_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_newswireos_payment_id_fkey"
    FOREIGN KEY ("newswireos_payment_id") REFERENCES "newswireos_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "notifications_member_id_kind_newswireos_payment_id_key"
    ON "notifications"("member_id", "kind", "newswireos_payment_id");
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing"
    CHECK (num_nonnulls("task_id", "transfer_id", "guardrail_event_id", "invoice_id", "cadence_lapse_id",
                        "newswireos_payment_id") = 1);

-- ── Lost verifications ───────────────────────────────────────────────────────────────────────────────────────────
-- The sweep that re-queues an invoice left `verifying` reads only those rows, oldest first: a small partial index,
-- not a scan of every invoice. (Built on a table that is small today; CONCURRENTLY cannot run inside a migration.)
CREATE INDEX "deal_invoices_verifying_updated_at_idx" ON "deal_invoices"("updated_at") WHERE "status" = 'verifying';
