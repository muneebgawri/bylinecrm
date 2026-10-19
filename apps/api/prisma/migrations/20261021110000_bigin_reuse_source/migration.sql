-- FR-CRMS-26: a recorded Bigin contact reuse says where it was found — by the sync as it happened (`sync`), or by
-- the historical reconcile that split people the old Bigin → Twenty job had mixed (`reconcile`).
ALTER TABLE "bigin_contact_reuses" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'sync';
ALTER TABLE "bigin_contact_reuses" ADD CONSTRAINT "bigin_contact_reuses_source" CHECK ("source" IN ('sync', 'reconcile'));
