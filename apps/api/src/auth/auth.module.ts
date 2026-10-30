import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { PlatformAccess } from '../platform/platform-access.service';
import { TransactionalMailModule } from '../transactional-mail/transactional-mail.module';
import { MembersService } from '../workspace/members.service';
import { MembershipService } from '../workspace/membership.service';
import { RolesService } from '../workspace/roles.service';
import {
    ApiKeysController,
    InvitesController,
    MembersController,
    RolesController,
    WorkspaceMeController,
} from '../workspace/workspace.controllers';
import { ApiKeyService } from './api-key.service';
import { AuthController, MeController } from './auth.controller';
import { ProfileService } from './profile.service';
import { AuthService } from './auth.service';
import { AuthGuard, CsrfGuard, RequestScopeMiddleware, RequiresGuard, WorkspaceGuard } from './guards';
import { OidcService } from './oidc.service';
import { OneTimeTokenService } from './one-time-token.service';
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter.service';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';

/**
 * Authentication and authorization for every route. The four guards run in this order on every
 * request: who is calling (AuthGuard) → is a cookie-authenticated mutation genuine (CsrfGuard) →
 * may the caller act in this workspace (WorkspaceGuard) → may they do this particular thing
 * (RequiresGuard). The request-scope middleware runs first so the guards have a context to fill.
 */
@Module({
    imports: [TransactionalMailModule],
    controllers: [
        AuthController,
        MeController,
        MembersController,
        RolesController,
        ApiKeysController,
        InvitesController,
        WorkspaceMeController,
    ],
    providers: [
        AuthService,
        SessionService,
        TwoFactorService,
        PasswordService,
        RateLimiter,
        OidcService,
        OneTimeTokenService,
        ApiKeyService,
        MembershipService,
        ProfileService,
        RolesService,
        MembersService,
        PlatformAccess,
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: WorkspaceGuard },
        { provide: APP_GUARD, useClass: RequiresGuard },
    ],
    exports: [AuthService, SessionService, ApiKeyService, MembershipService, RolesService, PlatformAccess, RateLimiter],
})
export class AuthModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RequestScopeMiddleware).forRoutes('*');
    }
}
