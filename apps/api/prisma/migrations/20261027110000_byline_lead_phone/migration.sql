-- BYL-3: a lead's phone BylineAI could not put in E.164 (and the CRM could not dial with the lead's country) is kept
-- as sent, on the lead, rather than dropped.
ALTER TABLE "byline_leads" ADD COLUMN "phone_raw" TEXT;
