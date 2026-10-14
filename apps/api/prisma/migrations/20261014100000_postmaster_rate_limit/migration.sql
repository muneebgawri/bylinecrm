-- #183: a Postmaster Tools 429 is a rate limit, not a refusal. A domain remembers when to ask again
-- (a day's reading is read once; a limit waits Retry-After or backs off from the check's cadence) and
-- how many limits in a row it has seen.
-- AlterEnum
ALTER TYPE "postmaster_domain_status" ADD VALUE 'rate_limited';
ALTER TYPE "postmaster_domain_status" ADD VALUE 'unreachable';

-- AlterTable
ALTER TABLE "sending_domains" ADD COLUMN     "postmaster_limited_times" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "postmaster_next_read_at" TIMESTAMPTZ;
