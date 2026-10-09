-- One representation of money (P1-1b review): a company's ARR becomes exact minor units with its
-- currency, the shape a deal's amount already has. Existing decimal values are converted (x100,
-- rounded to the unit) and an ARR without a currency takes the workspace's default.
ALTER TABLE "companies" ADD COLUMN "arr_minor" BIGINT;
UPDATE "companies" c
    SET "arr_minor" = round(c."arr_amount" * 100)::bigint,
        "arr_currency" = coalesce(c."arr_currency", w."default_currency")
    FROM "workspaces" w
    WHERE w."id" = c."workspace_id" AND c."arr_amount" IS NOT NULL;
ALTER TABLE "companies" DROP COLUMN "arr_amount";
-- Both or neither: an amount always has its currency.
ALTER TABLE "companies" ADD CONSTRAINT "companies_arr_pair" CHECK (("arr_minor" IS NULL) = ("arr_currency" IS NULL));
ALTER TABLE "companies" ADD CONSTRAINT "companies_arr_nonnegative" CHECK ("arr_minor" IS NULL OR "arr_minor" >= 0);
ALTER TABLE "companies" ADD CONSTRAINT "companies_arr_currency_upper" CHECK ("arr_currency" IS NULL OR "arr_currency" = upper("arr_currency"));
