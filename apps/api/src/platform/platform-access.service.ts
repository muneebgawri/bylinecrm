import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import type { Principal } from '../auth/principal';

/**
 * Who is a platform admin (P0-14): a person signed in with a session whose **verified** address is
 * in `PLATFORM_ADMIN_EMAILS`. Decided on every request from the current user row and the list —
 * there is no stored flag, so an address taken off the list loses access on the next request the
 * process serves with that list. An API key is never a platform admin: it belongs to a workspace.
 *
 * Reads `users` through the owner client (one row by primary key), like `AuthService.me`.
 */
@Injectable()
export class PlatformAccess {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
    ) {}

    async isPlatformAdmin(principal: Principal | undefined): Promise<boolean> {
        if (principal?.kind !== 'user') return false;
        const admins = this.env.PLATFORM_ADMIN_EMAILS;
        if (admins.length === 0) return false;
        const user = await this.ownerPrisma.user.findUnique({
            where: { id: principal.userId },
            select: { email: true, emailVerifiedAt: true },
        });
        return user !== null && user.emailVerifiedAt !== null && admins.includes(user.email);
    }

    /** Throws the documented `403 platform.forbidden` unless the caller is a platform admin. */
    async assertPlatformAdmin(principal: Principal | undefined): Promise<void> {
        if (!(await this.isPlatformAdmin(principal))) throw new PlatformForbidden();
    }
}

/** `403 platform.forbidden`: the route is for platform admins. */
export class PlatformForbidden extends ApiException {
    constructor(message = 'this is for platform admins') {
        super(403, 'platform.forbidden', message);
    }
}
