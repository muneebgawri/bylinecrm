-- OWN-2 (#201, FR-CRMS-20): a company's other domains, so a person writing from any of them is at that company.

-- CreateTable
CREATE TABLE "company_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_domains_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_domains_domain_lower" CHECK ("domain" = lower("domain"))
);

-- CreateIndex
CREATE UNIQUE INDEX "company_domains_workspace_id_domain_key" ON "company_domains"("workspace_id", "domain");
CREATE INDEX "company_domains_company_id_idx" ON "company_domains"("company_id");

-- AddForeignKey
ALTER TABLE "company_domains" ADD CONSTRAINT "company_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_domains" ADD CONSTRAINT "company_domains_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: a workspace's domains are its own. Not owner-scoped: who owns a domain is exactly what
-- every member must be able to learn, so that saving a lead at someone else's company is refused, by name.
ALTER TABLE "company_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "company_domains"
    FOR ALL TO bylinecrm_app
    USING (workspace_id = app_workspace_id())
    WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, DELETE ON "company_domains" TO bylinecrm_app;
