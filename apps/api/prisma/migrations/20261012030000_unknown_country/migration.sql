-- D-251 (#142): enrolments record that no country was known when the person was enrolled, and an
-- enrolment whose person later falls in a blocked region stops with its own reason.
ALTER TYPE "enrolment_stop_reason" ADD VALUE 'region_blocked';

ALTER TABLE "sequence_enrolments" ADD COLUMN "country_unknown_at_enrol" BOOLEAN NOT NULL DEFAULT false;
