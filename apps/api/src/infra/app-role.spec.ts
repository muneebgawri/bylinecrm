import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_DB_ROLE } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

/**
 * The migrations name the app role in SQL, where they cannot import the constant. This keeps
 * the two in step: a renamed constant, or a migration granting to some other role, fails here
 * before it fails as an unreadable table in production.
 */
describe('migrations and APP_DB_ROLE', () => {
    const grants =
        readdirSync(MIGRATIONS, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8'))
            .join('\n')
            .match(/\bTO\s+([a-z_][a-z0-9_]*)/g) ?? [];

    it('grant every privilege to the app role and to nothing else', () => {
        expect(grants.length).toBeGreaterThan(0);
        const roles = new Set(grants.map((g) => g.replace(/\bTO\s+/, '')));
        expect([...roles]).toEqual([APP_DB_ROLE]);
    });
});
