-- P3-4 Tracking (FR-CRMS-8). docs/design-notes/P3-4.md.

-- A tracked link clicked may move a deal by a stage rule, like a reply. An open never may: the enum
-- gets no 'email.opened', so a rule on it cannot be stored.
ALTER TYPE "stage_rule_event" ADD VALUE 'email.clicked';

CREATE TYPE "tracking_kind" AS ENUM ('click', 'open');

CREATE TABLE "tracking_domains" (
    "workspace_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "sending_domain_status" NOT NULL DEFAULT 'unchecked',
    "last_check" JSONB,
    "checked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tracking_domains_pkey" PRIMARY KEY ("workspace_id")
);
CREATE UNIQUE INDEX "tracking_domains_domain_key" ON "tracking_domains"("domain");

CREATE TABLE "tracking_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "outbound_id" UUID NOT NULL,
    "kind" "tracking_kind" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tracking_tokens_token_hash_key" ON "tracking_tokens"("token_hash");
CREATE INDEX "tracking_tokens_outbound_id_idx" ON "tracking_tokens"("outbound_id");

CREATE TABLE "tracking_hits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "outbound_id" UUID NOT NULL,
    "kind" "tracking_kind" NOT NULL,
    "person_id" UUID,
    "sequence_step_id" UUID,
    "enrolment_id" UUID,
    "happened_at" TIMESTAMPTZ NOT NULL,
    "user_agent" TEXT,
    "bot_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_hits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tracking_hits_outbound_id_kind_idx" ON "tracking_hits"("outbound_id", "kind");
CREATE INDEX "tracking_hits_sequence_step_id_kind_idx" ON "tracking_hits"("sequence_step_id", "kind");
CREATE INDEX "tracking_hits_token_id_idx" ON "tracking_hits"("token_id");

ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tracking_tokens" ADD CONSTRAINT "tracking_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tracking_tokens" ADD CONSTRAINT "tracking_tokens_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "mail_outbound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "tracking_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "mail_outbound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_sequence_step_id_fkey" FOREIGN KEY ("sequence_step_id") REFERENCES "sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "sequence_enrolments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the schema cannot say: a domain is stored as compared (a lower-case hostname), a token's URL
-- goes with a link and never with the pixel, and a bot reason is one the rule names.
ALTER TABLE "tracking_domains" ADD CONSTRAINT "tracking_domains_domain_host"
    CHECK ("domain" = lower("domain") AND "domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
ALTER TABLE "tracking_tokens" ADD CONSTRAINT "tracking_tokens_url_by_kind"
    CHECK (("kind" = 'click' AND "url" IS NOT NULL) OR ("kind" = 'open' AND "url" IS NULL));
ALTER TABLE "tracking_hits" ADD CONSTRAINT "tracking_hits_bot_reason_known"
    CHECK ("bot_reason" IS NULL OR "bot_reason" IN ('scanner_user_agent', 'too_soon_after_delivery'));

-- Row-level security: every table is a workspace's. The domain row is removed when the admin clears
-- it; a token lives as long as its send; a hit is never deleted by the app role.
ALTER TABLE "tracking_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "tracking_domains"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "tracking_domains" TO bylinecrm_app;

ALTER TABLE "tracking_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "tracking_tokens"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "tracking_tokens" TO bylinecrm_app;

ALTER TABLE "tracking_hits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_hits" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "tracking_hits"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON "tracking_hits" TO bylinecrm_app;
