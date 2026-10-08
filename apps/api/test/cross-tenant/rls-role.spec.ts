import 'reflect-metadata';
import { APP_DB_ROLE } from '@bylinecrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { WorkspaceContext } from '../../src/infra/workspace-context';

/**
 * The suite's own precondition. Every other spec here proves isolation *through the restricted
 * client*; if that client were the owner, they would all pass for the wrong reason. So this spec
 * fails the gate outright when RLS_DATABASE_URL logs in as anything but the app role, or as an
 * app role someone has let bypass RLS.
 */
describe('the restricted client', () => {
    let rls: RlsPrismaService;

    beforeAll(async () => {
        rls = new RlsPrismaService(parseEnv(process.env), new WorkspaceContext());
        await rls.$connect();
    });

    afterAll(async () => {
        await rls.$disconnect();
    });

    it(`logs in as ${APP_DB_ROLE} and cannot bypass row-level security`, async () => {
        const [row] = await rls.$queryRaw<{ current_user: string; rolbypassrls: boolean; rolsuper: boolean }[]>`
            SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
        expect(row).toEqual({ current_user: APP_DB_ROLE, rolbypassrls: false, rolsuper: false });
    });

    it('cannot become the owner with SET ROLE', async () => {
        const rows = await rls.$queryRaw<{ owner: string }[]>`
            SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`;
        const owner = rows[0]?.owner;
        expect(owner).toBeDefined();
        expect(owner).not.toBe(APP_DB_ROLE);
        await expect(rls.$executeRawUnsafe(`SET ROLE "${owner}"`)).rejects.toThrow(/permission denied/);
    });

    it('cannot read the migration history', async () => {
        await expect(rls.$queryRaw`SELECT count(*) FROM _prisma_migrations`).rejects.toThrow(/permission denied/);
    });
});
