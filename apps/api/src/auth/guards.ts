import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    UnauthorizedException,
    type NestMiddleware,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import type { NextFunction, Request, Response } from 'express';
import { requestIdOf } from '../infra/errors/request-id';
import { WorkspaceContext } from '../infra/workspace-context';
import { MembershipService } from '../workspace/membership.service';
import { RolesService } from '../workspace/roles.service';
import { ApiKeyService } from './api-key.service';
import { EmailUnverified } from './auth.service';
import { ANY_MEMBER_KEY, PUBLIC_KEY, REQUIRES_KEY, requiredCapabilities } from './decorators';
import type { AuthenticatedRequest } from './principal';
import { SessionService } from './session.service';

/** Every tenant route lives under this; the guards key on it. */
export const TENANT_PATH = '/api/w/';

/** A workspace id in the path is a UUID or the route does not exist for this caller. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Methods that change state and therefore need the CSRF header on a cookie-authenticated request. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Opens one `WorkspaceContext` scope per request, so a guard's decision cannot outlive it. */
@Injectable()
export class RequestScopeMiddleware implements NestMiddleware {
    constructor(private readonly context: WorkspaceContext) {}

    use(req: Request, res: Response, next: NextFunction): void {
        this.context.begin(next, requestIdOf(req, res));
    }
}

/**
 * Who is calling. A session cookie names a person; a bearer API key names a machine and its
 * workspace. A route marked `@Public()` passes without either; everything else is `401`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly sessions: SessionService,
        private readonly apiKeys: ApiKeyService,
    ) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
        const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (bearer) {
            const key = await this.apiKeys.resolve(bearer);
            if (key) req.principal = { kind: 'apiKey', ...key };
        } else {
            const token = cookie(req, SESSION_COOKIE);
            const session = token ? await this.sessions.resolve(token) : null;
            if (session) req.principal = { kind: 'user', ...session };
        }
        if (req.principal) return true;
        if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
        throw new UnauthorizedException();
    }
}

/**
 * Double-submit CSRF. A state-changing request made with the session cookie must carry the CSRF
 * cookie's value in the header; the browser attaches cookies on its own but never a custom
 * header cross-site. Bearer requests carry no ambient credential and are exempt, as are public
 * routes (nothing to forge a session for).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
        if (!MUTATING.has(req.method) || req.principal?.kind !== 'user') return true;
        const expected = cookie(req, CSRF_COOKIE);
        const presented = req.headers[CSRF_HEADER];
        if (!expected || typeof presented !== 'string' || presented !== expected) {
            throw new ForbiddenException('missing or mismatched CSRF token');
        }
        return true;
    }
}

/**
 * The gate for `/api/w/:workspaceId/…`: is the caller a member of that workspace (or a key of
 * it)? A non-member is refused before any tenant query is issued. On success the decision —
 * workspace, caller, capabilities — is recorded in `WorkspaceContext` for the handler and for
 * `withWorkspace`. Row-level security underneath makes a wrong decision fail closed.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
    constructor(
        private readonly context: WorkspaceContext,
        private readonly memberships: MembershipService,
        private readonly roles: RolesService,
    ) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
        if (!isTenantPath(req.path)) return true;
        const workspaceId = req.params['workspaceId'];
        const principal = req.principal;
        if (typeof workspaceId !== 'string' || !UUID.test(workspaceId) || !principal) throw new ForbiddenException();

        if (principal.kind === 'apiKey') {
            if (principal.workspaceId !== workspaceId) throw new ForbiddenException('key belongs to another workspace');
            const access = await this.roles.access(workspaceId, principal.roleId);
            if (!access) throw new ForbiddenException();
            // A role scoped to "own" records needs a member to be own relative to; a key has none.
            if (access.recordScope === 'own')
                throw new ForbiddenException('an own-scoped role cannot act through a key');
            this.context.set({
                workspaceId,
                apiKeyId: principal.apiKeyId,
                roleId: access.roleId,
                roleName: access.roleName,
                capabilities: access.capabilities,
            });
            return true;
        }

        // An unverified address reaches no workspace (#93): refused before any tenant query.
        if (!principal.emailVerified) throw new EmailUnverified();
        const membership = await this.memberships.find(principal.userId, workspaceId);
        if (!membership) throw new ForbiddenException('not a member of this workspace');
        const access = await this.roles.access(workspaceId, membership.roleId);
        if (!access) throw new ForbiddenException();
        this.context.set({
            workspaceId,
            userId: principal.userId,
            memberId: membership.memberId,
            roleId: access.roleId,
            roleName: access.roleName,
            capabilities: access.capabilities,
            ...(access.recordScope === 'own' ? { ownerScopeMemberId: membership.memberId } : {}),
        });
        return true;
    }
}

/**
 * The capabilities a tenant route declared with `@Requires()` — all of them — checked against what
 * the workspace guard recorded. A tenant route that declared nothing is refused outright: an
 * undeclared gate is a defect, not an open door.
 */
@Injectable()
export class RequiresGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly context: WorkspaceContext,
    ) {}

    canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        if (!isTenantPath(req.path)) return true;
        // A route open to any member (with its reason written down) has the workspace guard as its gate.
        if (typeof this.reflector.get<unknown>(ANY_MEMBER_KEY, ctx.getHandler()) === 'string') return true;
        const required = requiredCapabilities(this.reflector.get<unknown>(REQUIRES_KEY, ctx.getHandler()));
        if (!required) {
            throw new ForbiddenException('route declares no capability');
        }
        const held = this.context.get()?.capabilities;
        const missing = required.filter((capability) => !held?.has(capability));
        if (missing.length > 0) {
            throw new ForbiddenException(`requires ${missing.join(', ')}`);
        }
        return true;
    }
}

export function isTenantPath(path: string): boolean {
    return path.startsWith(TENANT_PATH);
}

function cookie(req: Request, name: string): string | undefined {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    return cookies?.[name];
}
