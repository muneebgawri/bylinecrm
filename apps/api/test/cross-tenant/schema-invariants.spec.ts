import 'reflect-metadata';
import { APP_DB_ROLE } from '@bylinecrm/shared';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env';

/**
 * The rule every later package inherits, checked against pg_catalog rather than against the
 * tables this package happens to know about: a tenant table (one with a `workspace_id` column)
 * must be RLS-enabled, RLS-forced, and covered by at least one policy for the app role; any
 * other table is either a scoped global table (RLS + policy) or something the app role cannot
 * touch at all. A table added without its policy fails CI the day it is added, not the day a
 * tenant leaks.
 */
interface TableRow {
    name: string;
    hasWorkspaceId: boolean;
    rowSecurity: boolean;
    forceRowSecurity: boolean;
    policiesForAppRole: number;
    grantsToAppRole: number;
}

describe('schema invariants', () => {
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    let tables: TableRow[];

    beforeAll(async () => {
        await owner.$connect();
        tables = await owner.$queryRaw<TableRow[]>`
            SELECT
                c.relname AS "name",
                EXISTS (
                    SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
                ) AS "hasWorkspaceId",
                c.relrowsecurity AS "rowSecurity",
                c.relforcerowsecurity AS "forceRowSecurity",
                (
                    SELECT count(*)::int FROM pg_policies p
                    WHERE p.schemaname = n.nspname AND p.tablename = c.relname
                      AND ${APP_DB_ROLE} = ANY (p.roles)
                ) AS "policiesForAppRole",
                (
                    SELECT count(*)::int FROM information_schema.role_table_grants g
                    WHERE g.table_schema = n.nspname AND g.table_name = c.relname
                      AND g.grantee = ${APP_DB_ROLE}
                ) AS "grantsToAppRole"
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY c.relname`;
    });

    afterAll(async () => {
        await owner.$disconnect();
    });

    it('sees the tables this package created', () => {
        const names = tables.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['workspaces', 'users', 'workspace_members']));
    });

    it('every tenant table is RLS-enabled, forced, and covered by a policy for the app role', () => {
        const tenant = tables.filter((t) => t.hasWorkspaceId);
        expect(tenant.length).toBeGreaterThan(0);
        const unprotected = tenant
            .filter((t) => !t.rowSecurity || !t.forceRowSecurity || t.policiesForAppRole === 0)
            .map((t) => t.name);
        expect(unprotected, 'tenant tables missing RLS or a policy').toEqual([]);
    });

    it('every other table is a scoped global table or out of the app role’s reach', () => {
        const others = tables.filter((t) => !t.hasWorkspaceId && t.name !== '_prisma_migrations');
        const exposed = others
            .filter((t) => !(t.rowSecurity && t.forceRowSecurity && t.policiesForAppRole > 0) && t.grantsToAppRole > 0)
            .map((t) => t.name);
        expect(exposed, 'tables the app role can reach without a policy').toEqual([]);
    });

    it('#93: mailed single-use links are out of the app role’s reach', () => {
        const links = tables.find((t) => t.name === 'one_time_tokens');
        expect(links, 'one_time_tokens exists').toBeDefined();
        expect(links?.grantsToAppRole).toBe(0);
    });

    it('#93: the mail outbox takes the app role’s inserts under RLS and nothing else', async () => {
        const mail = tables.find((t) => t.name === 'mail_outbox');
        expect(mail).toMatchObject({ rowSecurity: true, forceRowSecurity: true });
        const grants = await owner.$queryRaw<{ privilege: string }[]>`
            SELECT privilege_type AS "privilege" FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'mail_outbox' AND grantee = ${APP_DB_ROLE}`;
        expect(grants.map((g) => g.privilege)).toEqual(['INSERT']);
    });

    it('the migration history is out of the app role’s reach', () => {
        const history = tables.find((t) => t.name === '_prisma_migrations');
        expect(history?.grantsToAppRole).toBe(0);
    });
});
