import { applyDecorators, Controller, createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { type Capability, isCapability } from '@bylinecrm/shared';
import type { AuthenticatedRequest, Principal } from './principal';

export const PUBLIC_KEY = 'auth:public';
/** A route anyone may call without signing in (sign-up, login, health, the OIDC callbacks). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

export const REQUIRES_KEY = 'auth:requires';
/**
 * The capabilities a tenant route needs — all of them. Every route under `/api/w/:workspaceId`
 * declares at least one; the guard refuses a route that does not, and a unit test walks the
 * router to catch it earlier. Several are for a route that is more than one thing at once (a bulk
 * edit of deals: `@Requires('deal:bulk', 'deal:edit')`), so every gate stays on the route.
 */
export const Requires = (first: Capability, ...rest: Capability[]): MethodDecorator =>
    SetMetadata(REQUIRES_KEY, [first, ...rest]);

/** What `@Requires` recorded on a handler, or `null` when it recorded nothing usable. */
export function requiredCapabilities(metadata: unknown): readonly Capability[] | null {
    return Array.isArray(metadata) && metadata.length > 0 && metadata.every(isCapability) ? metadata : null;
}

/** The authenticated caller, as the auth guard recorded it. */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw new Error('CurrentPrincipal used on a route the auth guard did not authenticate');
    return principal;
});

export const SIGNED_INBOUND_KEY = 'auth:signed-inbound';
/**
 * A tenant-path route another system posts to (BYL-1: `POST /w/:id/inbound/byline`): no session, no key, no member —
 * the workspace guard and the capability guard let it through, and the handler admits nothing until the body's
 * signature checks out against that workspace's secret. The reason is required and the router-walking test lists
 * every such route: it is an exemption from the tenant gate, so each one is named.
 */
export const SignedInbound = (reason: string): MethodDecorator =>
    applyDecorators(SetMetadata(PUBLIC_KEY, true), SetMetadata(SIGNED_INBOUND_KEY, reason));

export const ANY_MEMBER_KEY = 'auth:any-member';
/**
 * A tenant route any member or key of the workspace may call, with the workspace guard as its
 * whole gate — a caller asking what *they* may do cannot be asked for a capability first. The
 * reason is required and the router-walking test reads it: an exemption nobody explained is
 * the same defect as a missing gate.
 */
export const AnyMember = (reason: string): MethodDecorator => SetMetadata(ANY_MEMBER_KEY, reason);

/**
 * A controller of tenant routes: mounted under `w/:workspaceId/<path>` and declaring that path
 * parameter in the OpenAPI document (the guard reads it, so no handler names it with `@Param`).
 * The one way to mount a tenant controller, so the prefix and its documentation cannot diverge.
 */
export const TenantController = (path: string): ClassDecorator =>
    applyDecorators(
        Controller(`w/:workspaceId/${path}`),
        ApiParam({ name: 'workspaceId', description: 'The workspace', schema: { type: 'string', format: 'uuid' } }),
    );
