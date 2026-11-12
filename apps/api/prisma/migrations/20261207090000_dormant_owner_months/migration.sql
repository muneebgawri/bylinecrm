-- OWN-2f: Settings → Ownership says how many months an owner may leave a company untouched and keep it. A column
-- with a constant default (no rewrite of the table, no rows touched); 0 turns the rule off.
ALTER TABLE "ownership_settings"
    ADD COLUMN "dormant_owner_months" INTEGER NOT NULL DEFAULT 6,
    ADD CONSTRAINT "ownership_settings_dormant_owner_months_check" CHECK ("dormant_owner_months" BETWEEN 0 AND 36);
