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
