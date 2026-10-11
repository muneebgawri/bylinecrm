import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
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
import { PasswordService } from './password.service';
import { RateLimiter } from './rate-limiter.service';
import { SessionService } from './session.service';

/**
 * Authentication and authorization for every route. The four guards run in this order on every
 * request: who is calling (AuthGuard) → is a cookie-authenticated mutation genuine (CsrfGuard) →
 * may the caller act in this workspace (WorkspaceGuard) → may they do this particular thing
 * (RequiresGuard). The request-scope middleware runs first so the guards have a context to fill.
 */
@Module({
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
        PasswordService,
        RateLimiter,
        OidcService,
        ApiKeyService,
        MembershipService,
        ProfileService,
        RolesService,
        MembersService,
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: WorkspaceGuard },
        { provide: APP_GUARD, useClass: RequiresGuard },
    ],
    exports: [AuthService, SessionService, ApiKeyService, MembershipService, RolesService, RateLimiter],
})
export class AuthModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RequestScopeMiddleware).forRoutes('*');
    }
}
