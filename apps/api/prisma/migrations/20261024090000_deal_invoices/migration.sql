-- INV-1 (#206, FR-CRMS-19): invoices on a deal, verified by NewswireOS before they count; the workspace's
-- NewswireOS link (verification URL, API token, refund/chargeback hook); the `invoice.verified` stage-rule event;
-- the `invoice_needs_review` notification; and the `invoice:verify` capability. Contract: docs/design-notes/INV-1.md.

-- CreateEnum
CREATE TYPE "invoice_gateway" AS ENUM ('stripe', 'paypal', 'crypto_onchain', 'bank_wire');
CREATE TYPE "invoice_status" AS ENUM ('verifying', 'verified', 'invalid', 'needs_review', 'invalidated');

-- AlterEnum
ALTER TYPE "stage_rule_event" ADD VALUE 'invoice.verified';
ALTER TYPE "linked_object" ADD VALUE 'invoice';
ALTER TYPE "notification_kind" ADD VALUE 'invoice_needs_review';
ALTER TYPE "notification_kind" ADD VALUE 'invoice_coverage_lost';

-- CreateTable
CREATE TABLE "deal_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "gateway" "invoice_gateway" NOT NULL,
    "reference" TEXT NOT NULL,
    "canonical_reference" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "refunded_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "attachment_id" UUID,
    "status" "invoice_status" NOT NULL DEFAULT 'verifying',
    "reason_code" TEXT,
    "note" TEXT,
    "verified_at" TIMESTAMPTZ,
    "invalidated_at" TIMESTAMPTZ,
    "verification_payload" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "decided_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deal_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "newswireos_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_token_ciphertext" TEXT NOT NULL,
    "hook_token_hash" TEXT NOT NULL,
    "hook_token_ciphertext" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "configured_by_id" UUID NOT NULL,
    "last_delivery_at" TIMESTAMPTZ,
    "last_delivery_result" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "newswireos_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One payment is one deal.
CREATE UNIQUE INDEX "deal_invoices_workspace_id_gateway_reference_key" ON "deal_invoices"("workspace_id", "gateway", "reference");
CREATE INDEX "deal_invoices_workspace_id_opportunity_id_idx" ON "deal_invoices"("workspace_id", "opportunity_id");
CREATE UNIQUE INDEX "newswireos_settings_workspace_id_key" ON "newswireos_settings"("workspace_id");
CREATE UNIQUE INDEX "newswireos_settings_hook_token_hash_key" ON "newswireos_settings"("hook_token_hash");

-- Shape: a positive amount, an upper-case currency, a reference with something in it; verified when verified.
ALTER TABLE "deal_invoices" ADD CONSTRAINT "deal_invoices_shape"
    CHECK ("amount_minor" > 0 AND "refunded_amount_minor" BETWEEN 0 AND "amount_minor" AND "currency" ~ '^[A-Z]{3}$' AND length(btrim("reference")) > 0
        AND (("status" = 'verified') <= ("verified_at" IS NOT NULL)));
ALTER TABLE "newswireos_settings" ADD CONSTRAINT "newswireos_settings_shape"
    CHECK ("base_url" ~ '^https?://[^/?#]+$');

-- AddForeignKey
ALTER TABLE "deal_invoices" ADD CONSTRAINT "deal_invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_invoices" ADD CONSTRAINT "deal_invoices_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_invoices" ADD CONSTRAINT "deal_invoices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deal_invoices" ADD CONSTRAINT "deal_invoices_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "workspace_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "newswireos_settings" ADD CONSTRAINT "newswireos_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "newswireos_settings" ADD CONSTRAINT "newswireos_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "workspace_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security in P0-2's shape. The public hook finds its workspace by the token through the owner client
-- (as Slotline's does); everything after that runs under the workspace's policy.
ALTER TABLE "deal_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deal_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "deal_invoices"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
-- A payment record: never deleted by the app; a refund marks it invalidated.
GRANT SELECT, INSERT, UPDATE ON "deal_invoices" TO bylinecrm_app;

ALTER TABLE "newswireos_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "newswireos_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "newswireos_settings"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "newswireos_settings" TO bylinecrm_app;

-- Notifications: about a task, a transfer, a guardrail event or an invoice: exactly one.
ALTER TABLE "notifications" ADD COLUMN "invoice_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "deal_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "notifications_member_id_kind_invoice_id_key" ON "notifications"("member_id", "kind", "invoice_id");
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing"
    CHECK (num_nonnulls("task_id", "transfer_id", "guardrail_event_id", "invoice_id") = 1);

-- The `manager` system role verifies invoices by hand (FR-CRMS-19).
INSERT INTO "role_permissions" ("id", "workspace_id", "role_id", "capability")
SELECT gen_random_uuid(), r."workspace_id", r."id", 'invoice:verify'
FROM "roles" r
WHERE r."name" = 'manager' AND r."is_system"
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role_id" = r."id" AND p."capability" = 'invoice:verify');
