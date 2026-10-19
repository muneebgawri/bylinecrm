-- #193: the profiles a member's signature shows as social icons — `{ "<network>": "<https url>" }`, validated by
-- the API against each network's own site.

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN     "social_links" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_social_links_shape"
    CHECK (jsonb_typeof("social_links") = 'object');
