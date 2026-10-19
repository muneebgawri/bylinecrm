-- OWN-2c (#201): a company's domain is its registrable domain — `www.acme.com`, `uk.acme.com` and `acme.com` are one
-- company. The API stores it so on every write from now on. This strips `www.` from what is stored; the rest of a
-- subdomain needs the Public Suffix List, which SQL lacks: `node dist/cli/normalise-company-domains.js --apply`
-- does it after deploy (docs/design-notes/OWN-2.md). A `www.` row whose bare
-- domain another company in the workspace already has (live or trashed) is left as it is: two records of one
-- company that a person must merge or delete. The Ownership page lists them (`duplicate_domain`), and lookups
-- still match them under their bare domain.

UPDATE "companies" c
SET "domain" = substr(c."domain", 5), "updated_at" = CURRENT_TIMESTAMP
WHERE c."domain" LIKE 'www.%'
  AND NOT EXISTS (
      SELECT 1 FROM "companies" o
      WHERE o."workspace_id" = c."workspace_id" AND o."id" <> c."id" AND o."domain" = substr(c."domain", 5)
  );

UPDATE "company_domains" d
SET "domain" = substr(d."domain", 5)
WHERE d."domain" LIKE 'www.%'
  AND NOT EXISTS (
      SELECT 1 FROM "company_domains" o
      WHERE o."workspace_id" = d."workspace_id" AND o."id" <> d."id" AND o."domain" = substr(d."domain", 5)
  );
