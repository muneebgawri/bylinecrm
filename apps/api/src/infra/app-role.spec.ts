import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DB_ROLE, OWNERSHIP_DB_ROLE, SEARCH_DB_ROLE } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

/**
 * The migrations name the database roles in SQL, where they cannot import the constants. This keeps
 * them in step: a renamed constant, or a migration granting to some other role, fails here
 * before it fails as an unreadable table in production.
 */
describe('migrations and the database roles', () => {
    const sql = readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8'))
        .join('\n');
    const grants = sql.match(/\bTO\s+([a-z_][a-z0-9_]*)/g) ?? [];

    it('grant privileges to the app role, the search role and the ownership role, and to nothing else', () => {
        expect(grants.length).toBeGreaterThan(0);
        const roles = new Set(grants.map((g) => g.replace(/\bTO\s+/, '')));
        expect([...roles].sort()).toEqual([APP_DB_ROLE, SEARCH_DB_ROLE, OWNERSHIP_DB_ROLE].sort());
    });

    /**
     * The search role bypasses RLS (#344): it may read people and their addresses, use the schema and own the search
     * function — never write, never read another table. Any other grant to it fails here.
     */
    it('give the search role SELECT on people and person_addresses, schema USAGE and ownership of people_search only', () => {
        const toSearch = [
            ...sql.matchAll(new RegExp(`(GRANT|ALTER FUNCTION)\\s[^;]*?\\bTO\\s+${SEARCH_DB_ROLE}\\b`, 'gi')),
        ].map((m) => m[0].replace(/\s+/g, ' ').trim());
        expect(toSearch.length).toBeGreaterThan(0);
        for (const statement of toSearch) {
            expect([
                `GRANT USAGE ON SCHEMA public TO ${SEARCH_DB_ROLE}`,
                `GRANT SELECT ON "people", "person_addresses" TO ${SEARCH_DB_ROLE}`,
                `ALTER FUNCTION people_search(text, text, text, text, boolean, int) OWNER TO ${SEARCH_DB_ROLE}`,
            ]).toContain(statement);
        }
    });

    /**
     * The ownership role bypasses RLS (OWN-2d): it may update companies and read members, use the schema and own the
     * claim function — never another table, never a delete. Any other grant to it fails here.
     */
    it('give the ownership role SELECT/UPDATE on companies, SELECT on workspace_members, SELECT and a company link on people, schema USAGE and its two functions only', () => {
        const toOwnership = [
            ...sql.matchAll(new RegExp(`(GRANT|ALTER FUNCTION)\\s[^;]*?\\bTO\\s+${OWNERSHIP_DB_ROLE}\\b`, 'gi')),
        ].map((m) => m[0].replace(/\s+/g, ' ').trim());
        expect(toOwnership.length).toBeGreaterThan(0);
        for (const statement of toOwnership) {
            expect([
                `GRANT USAGE ON SCHEMA public TO ${OWNERSHIP_DB_ROLE}`,
                `GRANT SELECT, UPDATE ON "companies" TO ${OWNERSHIP_DB_ROLE}`,
                `GRANT SELECT ON "workspace_members" TO ${OWNERSHIP_DB_ROLE}`,
                `ALTER FUNCTION claim_company(uuid, uuid) OWNER TO ${OWNERSHIP_DB_ROLE}`,
                // OWN-2f: the claim takes the owner it is taken from.
                `ALTER FUNCTION claim_company(uuid, uuid, uuid) OWNER TO ${OWNERSHIP_DB_ROLE}`,
                // OWN-2g: a company saved at a domain links the leads saved there before it.
                `GRANT SELECT ON "people" TO ${OWNERSHIP_DB_ROLE}`,
                `GRANT UPDATE ("company_id", "updated_at") ON "people" TO ${OWNERSHIP_DB_ROLE}`,
                `ALTER FUNCTION link_company_people(uuid, uuid[]) OWNER TO ${OWNERSHIP_DB_ROLE}`,
            ]).toContain(statement);
        }
    });
});
