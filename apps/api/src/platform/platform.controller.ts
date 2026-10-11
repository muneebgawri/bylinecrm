import {
    Body,
    type CanActivate,
    Controller,
    type ExecutionContext,
    Get,
    Inject,
    Injectable,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/decorators';
import { CreatePlatformWorkspaceDto, CreateSignupInviteDto } from '../auth/dto';
import type { AuthenticatedRequest, Principal } from '../auth/principal';
import { ENV, type Env } from '../config/env';
import { Returns } from '../openapi/responses';
import { PlatformAccess } from './platform-access.service';
import { PlatformService } from './platform.service';
import {
    createdPlatformWorkspace,
    platformAccess,
    platformInvite,
    platformWorkspace,
    type CreatedPlatformWorkspaceView,
    type PlatformAccessView,
    type PlatformInviteView,
    type PlatformWorkspaceView,
} from './responses';

/** Lets a request through only when its caller is a platform admin, decided afresh each time. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
    constructor(private readonly access: PlatformAccess) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        await this.access.assertPlatformAdmin(ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal);
        return true;
    }
}

/**
 * The operator's routes (P0-14): creating workspaces for other people and inviting sign-ups. Not
 * tenant routes — no workspace is the context — so the workspace and capability guards pass them
 * by, and `PlatformAdminGuard` is the gate on each one except `access`, which tells any signed-in
 * caller whether they are a platform admin (the web app uses it to show the page).
 */
@ApiTags('platform')
@Controller('platform')
export class PlatformController {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly access: PlatformAccess,
        private readonly platform: PlatformService,
    ) {}

    @Get('access')
    @Returns(platformAccess)
    async myAccess(@CurrentPrincipal() principal: Principal): Promise<PlatformAccessView> {
        return { platformAdmin: await this.access.isPlatformAdmin(principal), signupMode: this.env.SIGNUP_MODE };
    }

    @UseGuards(PlatformAdminGuard)
    @Get('workspaces')
    @Returns([platformWorkspace])
    workspaces(): Promise<PlatformWorkspaceView[]> {
        return this.platform.listWorkspaces();
    }

    @UseGuards(PlatformAdminGuard)
    @Post('workspaces')
    @Returns(createdPlatformWorkspace)
    createWorkspace(
        @Body() body: CreatePlatformWorkspaceDto,
        @CurrentPrincipal() principal: Principal,
    ): Promise<CreatedPlatformWorkspaceView> {
        return this.platform.createWorkspace(userIdOf(principal), body);
    }

    @UseGuards(PlatformAdminGuard)
    @Post('signup-invites')
    @Returns(platformInvite)
    createSignupInvite(
        @Body() body: CreateSignupInviteDto,
        @CurrentPrincipal() principal: Principal,
    ): Promise<PlatformInviteView> {
        return this.platform.createSignupInvite(userIdOf(principal), body.email);
    }
}

/** The guard admitted only a person; this states it to the type system. */
function userIdOf(principal: Principal): string {
    if (principal.kind !== 'user') throw new Error('a platform route admitted a non-person');
    return principal.userId;
}
