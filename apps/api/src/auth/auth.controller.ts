import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    Inject,
    NotImplementedException,
    Param,
    Patch,
    Post,
    Req,
    Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SESSION_COOKIE } from '@bylinecrm/shared';
import type { Request, Response } from 'express';
import { ENV, type Env } from '../config/env';
import { MembershipService } from '../workspace/membership.service';
import { AuthService, type UserView, type WorkspaceView } from './auth.service';
import { AuthCookies } from './cookies';
import { CurrentPrincipal, Public } from './decorators';
import { AcceptInviteSignupDto, CreateWorkspaceDto, LoginDto, SignupDto, UpdateProfileDto } from './dto';
import { ProfileService } from './profile.service';
import { OidcService } from './oidc.service';
import type { Principal } from './principal';
import { SessionService } from './session.service';
import { randomToken } from './tokens';
import { NotImplementedYet, Redirects, Returns } from '../openapi/responses';
import { authProviders, profileView, signedIn, signedUp, userView, workspaceView } from '../workspace/responses';
import type { ProfileView } from '../workspace/responses';

/** Sign-up, sign-in and sign-out, for people. Machines use API keys and never come here. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
    private readonly cookies: AuthCookies;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly auth: AuthService,
        private readonly sessions: SessionService,
        private readonly oidc: OidcService,
    ) {
        this.cookies = AuthCookies.fromAppUrl(env.APP_URL);
    }

    @Public()
    @Post('signup')
    @Returns(signedUp)
    async signup(
        @Body() body: SignupDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<{ user: UserView; workspace: WorkspaceView }> {
        const result = await this.auth.signup(body);
        await this.startSession(req, res, result.user.id);
        return result;
    }

    @Public()
    @HttpCode(200)
    @Post('login')
    @Returns(signedIn)
    async login(
        @Body() body: LoginDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<{ user: UserView }> {
        const user = await this.auth.login({ ...body, ip: req.ip ?? '' });
        await this.startSession(req, res, user.id);
        return { user };
    }

    @HttpCode(204)
    @Post('logout')
    async logout(@CurrentPrincipal() principal: Principal, @Res({ passthrough: true }) res: Response): Promise<void> {
        if (principal.kind === 'user') await this.sessions.revoke(principal.sessionId);
        this.cookies.clear(res);
    }

    /** Which identity providers this deployment offers. */
    @Public()
    @Get('providers')
    @Returns(authProviders)
    providers(): { providers: string[] } {
        return { providers: this.oidc.available() };
    }

    /** Google is the OIDC issuer `google`; the route exists so the web app has a stable name. */
    @Public()
    @Get('google')
    @Redirects()
    async google(@Res() res: Response): Promise<void> {
        res.redirect((await this.oidc.start('google')).toString());
    }

    @Public()
    @Get('google/callback')
    @Redirects()
    googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.oidcCallback('google', req, res);
    }

    @Public()
    @Get('oidc/:issuer')
    @Redirects()
    async oidcStart(@Param('issuer') issuer: string, @Res() res: Response): Promise<void> {
        res.redirect((await this.oidc.start(issuer)).toString());
    }

    @Public()
    @Get('oidc/:issuer/callback')
    @Redirects()
    oidcCallback(@Param('issuer') issuer: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.finishOidc(issuer, req, res);
    }

    /** Joining a workspace with an invitation while signed in. */
    @HttpCode(200)
    @Post('invites/:token/accept')
    @Returns(workspaceView)
    async acceptInvite(
        @Param('token') token: string,
        @CurrentPrincipal() principal: Principal,
    ): Promise<WorkspaceView> {
        if (principal.kind !== 'user') throw new ForbiddenException('an API key cannot accept an invitation');
        return (await this.auth.acceptInvite(token, { userId: principal.userId })).workspace;
    }

    /** Creating an account from an invitation: the invited address is the account's, verified. */
    @Public()
    @Post('invites/:token/signup')
    @Returns(workspaceView)
    async acceptInviteSignup(
        @Param('token') token: string,
        @Body() body: AcceptInviteSignupDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<WorkspaceView> {
        const { workspace, userId } = await this.auth.acceptInvite(token, { signup: body });
        await this.startSession(req, res, userId);
        return workspace;
    }

    /** Password reset is designed, not built: the design note names the flow. */
    @Public()
    @Post('password/forgot')
    @NotImplementedYet()
    forgotPassword(): never {
        throw new NotImplementedException('password reset is not available yet');
    }

    /**
     * Logs the browser in as `userId`: a new session replaces any session the cookie already
     * names (rotation against fixation), and a fresh CSRF token rides alongside.
     */
    private async startSession(req: Request, res: Response, userId: string): Promise<void> {
        const previous = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
        const previousSession = previous ? await this.sessions.resolve(previous) : null;
        const { token } = await this.sessions.create(userId, previousSession?.sessionId);
        this.cookies.set(res, token, randomToken());
    }

    private async finishOidc(issuer: string, req: Request, res: Response): Promise<void> {
        const callbackUrl = new URL(req.originalUrl, this.env.APP_URL);
        const identity = await this.oidc.finish(issuer, callbackUrl);
        const user = await this.auth.signInWithIdentity(identity);
        await this.startSession(req, res, user.id);
        res.redirect(this.env.WEB_URL);
    }
}

/** The signed-in person and their workspaces. */
@ApiTags('me')
@Controller()
export class MeController {
    constructor(
        private readonly auth: AuthService,
        private readonly memberships: MembershipService,
        private readonly profiles: ProfileService,
    ) {}

    @Get('me')
    @Returns(userView)
    me(@CurrentPrincipal() principal: Principal): Promise<UserView> {
        if (principal.kind !== 'user') throw new ForbiddenException('an API key has no profile');
        return this.auth.me(principal.userId);
    }

    @Get('me/profile')
    @Returns(profileView)
    profile(@CurrentPrincipal() principal: Principal): Promise<ProfileView> {
        if (principal.kind !== 'user') throw new ForbiddenException('an API key has no profile');
        return this.profiles.get(principal.userId);
    }

    @Patch('me/profile')
    @Returns(profileView)
    updateProfile(@Body() body: UpdateProfileDto, @CurrentPrincipal() principal: Principal): Promise<ProfileView> {
        if (principal.kind !== 'user') throw new ForbiddenException('an API key has no profile');
        return this.profiles.setDisplayName(principal.userId, body.displayName);
    }

    @Get('me/workspaces')
    @Returns([workspaceView])
    workspaces(@CurrentPrincipal() principal: Principal): Promise<WorkspaceView[]> {
        if (principal.kind !== 'user') throw new ForbiddenException('an API key belongs to one workspace');
        return this.memberships.workspacesOf(principal.userId);
    }

    @Post('workspaces')
    @Returns(workspaceView)
    createWorkspace(
        @Body() body: CreateWorkspaceDto,
        @CurrentPrincipal() principal: Principal,
    ): Promise<WorkspaceView> {
        if (principal.kind !== 'user') throw new ForbiddenException('an API key cannot create workspaces');
        return this.auth.createWorkspace(principal.userId, body.name);
    }
}
