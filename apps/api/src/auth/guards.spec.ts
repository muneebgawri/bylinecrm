import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_COOKIE, CSRF_HEADER } from '@bylinecrm/shared';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceContext } from '../infra/workspace-context';
import type { MembershipService } from '../workspace/membership.service';
import type { RolesService } from '../workspace/roles.service';
import { REQUIRES_KEY, Requires } from './decorators';
import { CsrfGuard, RequiresGuard, WorkspaceGuard } from './guards';
import type { AuthenticatedRequest, Principal } from './principal';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

function context(req: Partial<AuthenticatedRequest>, handler: object = {}): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => handler,
        getClass: () => class {},
    } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
    const guard = new CsrfGuard();
    const user: Principal = { kind: 'user', userId: 'u', sessionId: 's', emailVerified: true };

    it('lets a cookie-authenticated mutation through when the header echoes the cookie', () => {
        const req = {
            method: 'POST',
            principal: user,
            cookies: { [CSRF_COOKIE]: 'tok' },
            headers: { [CSRF_HEADER]: 'tok' },
        };
        expect(guard.canActivate(context(req))).toBe(true);
    });

    it('refuses a cookie-authenticated mutation with no header', () => {
        const req = { method: 'DELETE', principal: user, cookies: { [CSRF_COOKIE]: 'tok' }, headers: {} };
        expect(() => guard.canActivate(context(req))).toThrow(ForbiddenException);
    });

    it('refuses a mismatched header', () => {
        const req = {
            method: 'PATCH',
            principal: user,
            cookies: { [CSRF_COOKIE]: 'tok' },
            headers: { [CSRF_HEADER]: 'other' },
        };
        expect(() => guard.canActivate(context(req))).toThrow(ForbiddenException);
    });

    it('ignores reads, bearer callers and public routes', () => {
        const key: Principal = { kind: 'apiKey', apiKeyId: 'k', workspaceId: WORKSPACE_A, roleId: 'r' };
        expect(guard.canActivate(context({ method: 'GET', principal: user, cookies: {}, headers: {} }))).toBe(true);
        expect(guard.canActivate(context({ method: 'POST', principal: key, headers: {} }))).toBe(true);
        expect(guard.canActivate(context({ method: 'POST', headers: {} }))).toBe(true);
    });
});

describe('RequiresGuard', () => {
    const workspaceContext = new WorkspaceContext();
    const guard = new RequiresGuard(new Reflector(), workspaceContext);

    class Routes {
        @Requires('deal:bulk')
        declared(): void {}
        @Requires('deal:bulk', 'deal:edit')
        both(): void {}
        undeclared(): void {}
    }
    const declared = Routes.prototype.declared;
    const both = Routes.prototype.both;
    const undeclared = Routes.prototype.undeclared;

    it('records the capabilities on the handler', () => {
        expect(Reflect.getMetadata(REQUIRES_KEY, declared)).toEqual(['deal:bulk']);
        expect(Reflect.getMetadata(REQUIRES_KEY, both)).toEqual(['deal:bulk', 'deal:edit']);
    });

    it('a route that names several needs all of them: one of the two is 403, naming what is missing', () => {
        const path = { path: `/api/w/${WORKSPACE_A}/opportunities/bulk` };
        for (const held of [['deal:bulk'], ['deal:edit']] as const) {
            expect(() =>
                workspaceContext.run({ workspaceId: WORKSPACE_A, capabilities: new Set(held) }, () =>
                    guard.canActivate(context(path, both)),
                ),
            ).toThrow(ForbiddenException);
        }
        expect(() =>
            workspaceContext.run({ workspaceId: WORKSPACE_A, capabilities: new Set(['deal:bulk']) }, () =>
                guard.canActivate(context(path, both)),
            ),
        ).toThrow(/requires deal:edit/);
        const allowed = workspaceContext.run(
            { workspaceId: WORKSPACE_A, capabilities: new Set(['deal:bulk', 'deal:edit']) },
            () => guard.canActivate(context(path, both)),
        );
        expect(allowed).toBe(true);
    });

    it('passes when the caller holds the declared capability', () => {
        const result = workspaceContext.run({ workspaceId: WORKSPACE_A, capabilities: new Set(['deal:bulk']) }, () =>
            guard.canActivate(context({ path: `/api/w/${WORKSPACE_A}/deals/bulk` }, declared)),
        );
        expect(result).toBe(true);
    });

    it('refuses a member whose role lacks it', () => {
        expect(() =>
            workspaceContext.run({ workspaceId: WORKSPACE_A, capabilities: new Set(['deal:read']) }, () =>
                guard.canActivate(context({ path: `/api/w/${WORKSPACE_A}/deals/bulk` }, declared)),
            ),
        ).toThrow(/requires deal:bulk/);
    });

    it('refuses a tenant route that declared nothing, even for an admin', () => {
        expect(() =>
            workspaceContext.run({ workspaceId: WORKSPACE_A, capabilities: new Set(['workspace:admin']) }, () =>
                guard.canActivate(context({ path: `/api/w/${WORKSPACE_A}/anything` }, undeclared)),
            ),
        ).toThrow(/declares no capability/);
    });

    it('does not apply outside tenant paths', () => {
        expect(guard.canActivate(context({ path: '/api/me' }, undeclared))).toBe(true);
    });
});

describe('WorkspaceGuard', () => {
    function build(membership: { memberId: string; roleId: string } | null) {
        const workspaceContext = new WorkspaceContext();
        const memberships = { find: vi.fn().mockResolvedValue(membership) } as unknown as MembershipService;
        const roles = {
            access: vi.fn().mockResolvedValue({ capabilities: new Set(['record:read']), recordScope: 'all' }),
        } as unknown as RolesService;
        const guard = new WorkspaceGuard(workspaceContext, memberships, roles);
        return { guard, workspaceContext, memberships, roles };
    }
    const user: Principal = { kind: 'user', userId: 'u', sessionId: 's', emailVerified: true };

    it('refuses a non-member before any workspace-scoped query is made', async () => {
        const { guard, workspaceContext, roles } = build(null);
        await expect(
            workspaceContext.begin(() =>
                guard.canActivate(
                    context({
                        path: `/api/w/${WORKSPACE_B}/roles`,
                        params: { workspaceId: WORKSPACE_B },
                        principal: user,
                    }),
                ),
            ),
        ).rejects.toThrow(/not a member/);
        expect(roles.access).not.toHaveBeenCalled();
        expect(workspaceContext.get()).toBeUndefined();
    });

    it('#93: refuses an unverified person before looking up any membership', async () => {
        const { guard, workspaceContext, memberships, roles } = build({ memberId: 'm', roleId: 'r' });
        const unverified: Principal = { kind: 'user', userId: 'u', sessionId: 's', emailVerified: false };
        await expect(
            workspaceContext.begin(() =>
                guard.canActivate(
                    context({
                        path: `/api/w/${WORKSPACE_A}/roles`,
                        params: { workspaceId: WORKSPACE_A },
                        principal: unverified,
                    }),
                ),
            ),
        ).rejects.toMatchObject({ code: 'email.unverified' });
        expect(memberships.find).not.toHaveBeenCalled();
        expect(roles.access).not.toHaveBeenCalled();
        expect(workspaceContext.get()).toBeUndefined();
    });

    it('refuses an API key used against another workspace without consulting roles', async () => {
        const { guard, workspaceContext, memberships, roles } = build(null);
        const key: Principal = { kind: 'apiKey', apiKeyId: 'k', workspaceId: WORKSPACE_A, roleId: 'r' };
        await expect(
            workspaceContext.begin(() =>
                guard.canActivate(
                    context({
                        path: `/api/w/${WORKSPACE_B}/roles`,
                        params: { workspaceId: WORKSPACE_B },
                        principal: key,
                    }),
                ),
            ),
        ).rejects.toThrow(/another workspace/);
        expect(memberships.find).not.toHaveBeenCalled();
        expect(roles.access).not.toHaveBeenCalled();
    });

    it('records the member, workspace and capabilities for a member', async () => {
        const { guard, workspaceContext } = build({ memberId: 'm', roleId: 'r' });
        await workspaceContext.begin(async () => {
            await guard.canActivate(
                context({ path: `/api/w/${WORKSPACE_A}/roles`, params: { workspaceId: WORKSPACE_A }, principal: user }),
            );
            expect(workspaceContext.get()).toEqual({
                workspaceId: WORKSPACE_A,
                userId: 'u',
                memberId: 'm',
                capabilities: new Set(['record:read']),
            });
        });
    });

    it('refuses a path whose workspace id is not a UUID', async () => {
        const { guard, workspaceContext, memberships } = build({ memberId: 'm', roleId: 'r' });
        await expect(
            workspaceContext.begin(() =>
                guard.canActivate(
                    context({
                        path: '/api/w/not-a-uuid/roles',
                        params: { workspaceId: 'not-a-uuid' },
                        principal: user,
                    }),
                ),
            ),
        ).rejects.toThrow(ForbiddenException);
        expect(memberships.find).not.toHaveBeenCalled();
    });
});
