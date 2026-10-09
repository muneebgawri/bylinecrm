import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Capability } from '@bylinecrm/shared';
import type { AuthenticatedRequest, Principal } from './principal';

export const PUBLIC_KEY = 'auth:public';
/** A route anyone may call without signing in (sign-up, login, health, the OIDC callbacks). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

export const REQUIRES_KEY = 'auth:requires';
/**
 * The capability a tenant route needs. Every route under `/api/w/:workspaceId` must declare one;
 * the guard refuses a route that does not, and a unit test walks the router to catch it earlier.
 */
export const Requires = (capability: Capability): MethodDecorator => SetMetadata(REQUIRES_KEY, capability);

/** The authenticated caller, as the auth guard recorded it. */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw new Error('CurrentPrincipal used on a route the auth guard did not authenticate');
    return principal;
});

export const ANY_MEMBER_KEY = 'auth:any-member';
/**
 * A tenant route any member or key of the workspace may call, with the workspace guard as its
 * whole gate — a caller asking what *they* may do cannot be asked for a capability first. The
 * reason is required and the router-walking test reads it: an exemption nobody explained is
 * the same defect as a missing gate.
 */
export const AnyMember = (reason: string): MethodDecorator => SetMetadata(ANY_MEMBER_KEY, reason);
