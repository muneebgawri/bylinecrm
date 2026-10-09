import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env';
import { NoWorkspaceError, RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { WorkspaceContext } from '../../src/infra/workspace-context';

/**
 * Two workspaces, A and B, each with one member. Everything below goes through the restricted
 * client scoped to A and must never see, change or create anything in B. Rows are created by
 * the owner client (the way P0-3's sign-up will) and removed after each test, so the specs are
 * independent of one another and of what is already in the database.
 */
describe('workspace isolation', () => {
    const env = parseEnv(process.env);
    const owner = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const context = new WorkspaceContext();
    const rls = new RlsPrismaService(env, context);

    let a: string;
    let b: string;
    let userA: string;
    let userB: string;
    let memberB: string;
    let roleB: string;

    beforeAll(async () => {
        await Promise.all([owner.$connect(), rls.$connect()]);
    });

    afterAll(async () => {
        await Promise.all([owner.$disconnect(), rls.$disconnect()]);
    });

    beforeEach(async () => {
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const wa = await owner.workspace.create({ data: { slug: `a-${stamp}`, name: 'A' } });
        const wb = await owner.workspace.create({ data: { slug: `b-${stamp}`, name: 'B' } });
        const ua = await owner.user.create({ data: { email: `a-${stamp}@example.test` } });
        const ub = await owner.user.create({ data: { email: `b-${stamp}@example.test` } });
        const ra = await owner.role.create({ data: { workspaceId: wa.id, name: 'admin', isSystem: true } });
        const rb = await owner.role.create({ data: { workspaceId: wb.id, name: 'admin', isSystem: true } });
        await owner.workspaceMember.create({ data: { workspaceId: wa.id, userId: ua.id, roleId: ra.id } });
        const mb = await owner.workspaceMember.create({ data: { workspaceId: wb.id, userId: ub.id, roleId: rb.id } });
        [a, b, userA, userB, memberB, roleB] = [wa.id, wb.id, ua.id, ub.id, mb.id, rb.id];
    });

    afterEach(async () => {
        // Members cascade from workspaces; users are global and removed by id.
        await owner.workspace.deleteMany({ where: { id: { in: [a, b] } } });
        await owner.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    });

    it('reads only its own members', async () => {
        const members = await rls.withWorkspace(a, (tx) => tx.workspaceMember.findMany());
        expect(members.map((m) => m.workspaceId)).toEqual([a]);
    });

    it("updates none of the other workspace's rows", async () => {
        const result = await rls.withWorkspace(a, (tx) =>
            tx.workspaceMember.updateMany({ where: { id: memberB }, data: { updatedAt: new Date() } }),
        );
        expect(result.count).toBe(0);
    });

    it("deletes none of the other workspace's rows", async () => {
        const result = await rls.withWorkspace(a, (tx) => tx.workspaceMember.deleteMany({ where: { id: memberB } }));
        expect(result.count).toBe(0);
        await expect(owner.workspaceMember.findUnique({ where: { id: memberB } })).resolves.not.toBeNull();
    });

    it('is refused a row written into the other workspace', async () => {
        await expect(
            rls.withWorkspace(a, (tx) =>
                tx.workspaceMember.create({ data: { workspaceId: b, userId: userA, roleId: roleB } }),
            ),
        ).rejects.toThrow(/row-level security/);
    });

    it('sees itself and its own members among the global tables, nothing else', async () => {
        const [workspaces, users] = await rls.withWorkspace(a, (tx) =>
            Promise.all([tx.workspace.findMany(), tx.user.findMany()]),
        );
        expect(workspaces.map((w) => w.id)).toEqual([a]);
        expect(users.map((u) => u.id)).toEqual([userA]);
    });

    it('sees nothing at all without a workspace set', async () => {
        const [members, workspaces, users] = await Promise.all([
            rls.workspaceMember.findMany(),
            rls.workspace.findMany(),
            rls.user.findMany(),
        ]);
        expect(members).toEqual([]);
        expect(workspaces).toEqual([]);
        expect(users).toEqual([]);
    });

    it('refuses to scope a query when neither an id nor a context is given', async () => {
        await expect(rls.withWorkspace((tx) => tx.workspaceMember.findMany())).rejects.toBeInstanceOf(NoWorkspaceError);
    });

    it('takes the workspace from the ambient context when no id is passed', async () => {
        const members = await context.run({ workspaceId: b, capabilities: new Set() }, () =>
            rls.withWorkspace((tx) => tx.workspaceMember.findMany()),
        );
        expect(members.map((m) => m.id)).toEqual([memberB]);
    });

    it('does not leak the setting past the transaction', async () => {
        await rls.withWorkspace(a, (tx) => tx.workspaceMember.findMany());
        // Same pool, a new statement outside any transaction: the local setting must be gone.
        const rows = await rls.$queryRaw<{ setting: string | null }[]>`SELECT app_workspace_id()::text AS setting`;
        expect(rows[0]?.setting).toBeNull();
    });
});
