-- #190: domain health for every sending domain. A personal mailbox's domain is a sending domain too
-- (monitored, never gated), and so is every domain the connected Postmaster Tools account lists.
-- Postmaster's 429 with RESOURCE_EXHAUSTED naming the project's quota is its own status: an admin
-- raises the quota. Expand-only.
-- AlterEnum
ALTER TYPE "postmaster_domain_status" ADD VALUE 'quota_exhausted';

-- AlterTable
ALTER TABLE "sending_domains" ADD COLUMN     "in_postmaster" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "postmaster_read_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "postmaster_connections" ADD COLUMN     "domains_next_list_at" TIMESTAMPTZ;

-- Every connected mailbox's domain, pool or personal, is a sending domain, due for its first check.
INSERT INTO "sending_domains" ("workspace_id", "domain", "updated_at")
SELECT DISTINCT "workspace_id", lower(substring("email" from position('@' in "email") + 1)), now()
FROM "mailboxes"
WHERE "status" <> 'disconnected' AND position('@' in "email") > 0
ON CONFLICT ("workspace_id", "domain") DO NOTHING;
