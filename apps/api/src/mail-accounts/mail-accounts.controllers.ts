import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
    Req,
    Res,
} from '@nestjs/common';
import { ApiExtraModels, ApiTags } from '@nestjs/swagger';
import { MAILBOX_CONNECT_RESULT_PARAM } from '@bylinecrm/shared';
import type { Response } from 'express';
import { Public, Requires, TenantController } from '../auth/decorators';
import type { AuthenticatedRequest } from '../auth/principal';
import { ENV, type Env } from '../config/env';
import { Redirects, Returns } from '../openapi/responses';
import { ConnectMailboxDto, OAuthCallbackQueryDto, PutOAuthClientDto, UpdateMailboxDto } from './dto';
import { MailboxesService, type ConnectOutcome } from './mailboxes.service';
import { OAuthClientsService } from './oauth-clients.service';
import {
    connectStart,
    mailboxCheck,
    mailboxConnectResult,
    mailboxDisconnected,
    mailboxView,
    oauthClientView,
    type ConnectStart,
    type MailboxCheck,
    type MailboxDisconnected,
    type MailboxView,
    type OAuthClientView,
} from './responses';

/**
 * The workspace's Google OAuth client (D-237). Administrators only: it decides whose Google Cloud
 * project the workspace's mail flows through.
 */
@ApiTags('mail')
@TenantController('mail/oauth-client')
export class OAuthClientController {
    constructor(private readonly clients: OAuthClientsService) {}

    /** The setup screen's facts — the redirect URI and the scopes — also before anything is configured. */
    @Requires('workspace:admin')
    @Get()
    @Returns(oauthClientView)
    describe(): Promise<OAuthClientView> {
        return this.clients.describe();
    }

    /** Sets the client; the secret is stored encrypted and never shown again beyond its last four characters. */
    @Requires('workspace:admin')
    @Put()
    @Returns(oauthClientView)
    put(@Body() body: PutOAuthClientDto): Promise<OAuthClientView> {
        return this.clients.put(body);
    }

    /** Refused while any mailbox connected through the client is not disconnected. */
    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete()
    remove(): Promise<void> {
        return this.clients.remove();
    }

    /** Checks what Google will say about the client without a person signing in, and records it. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('verify')
    @Returns(oauthClientView)
    verify(): Promise<OAuthClientView> {
        return this.clients.verify();
    }
}

/** The mailboxes connected to the workspace. */
@ApiTags('mail')
@ApiExtraModels()
@TenantController('mailboxes')
export class MailboxesController {
    constructor(private readonly mailboxes: MailboxesService) {}

    @Requires('mailbox:read')
    @Get()
    @Returns([mailboxView])
    list(): Promise<MailboxView[]> {
        return this.mailboxes.list();
    }

    /** Starts a connect for the signed-in member; send the browser to `authorizeUrl`. */
    @Requires('mailbox:manage')
    @HttpCode(201)
    @Post('connect')
    @Returns(connectStart)
    connect(@Body() body: ConnectMailboxDto): Promise<ConnectStart> {
        return this.mailboxes.startConnect(body.purpose);
    }

    @Requires('mailbox:read')
    @Get(':mailboxId')
    @Returns(mailboxView)
    get(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<MailboxView> {
        return this.mailboxes.get(mailboxId);
    }

    /** The label. A different `purpose` is refused with `409`: disconnect and connect again instead. */
    @Requires('mailbox:manage')
    @Patch(':mailboxId')
    @Returns(mailboxView)
    update(@Param('mailboxId', ParseUUIDPipe) mailboxId: string, @Body() body: UpdateMailboxDto): Promise<MailboxView> {
        return this.mailboxes.update(mailboxId, body);
    }

    /** Revokes the grant at Google and wipes the stored tokens; the mailbox stays listed as disconnected. */
    @Requires('mailbox:manage')
    @HttpCode(200)
    @Delete(':mailboxId')
    @Returns(mailboxDisconnected)
    disconnect(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<MailboxDisconnected> {
        return this.mailboxes.disconnect(mailboxId);
    }

    /** A usable token and the scopes Google says it carries; a failure moves the mailbox to `reconnect_needed`. */
    @Requires('mailbox:manage')
    @HttpCode(200)
    @Post(':mailboxId/check')
    @Returns(mailboxCheck)
    check(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<MailboxCheck> {
        return this.mailboxes.check(mailboxId);
    }
}

/**
 * Where Google sends the browser back after consent. Public — Google's redirect carries no API
 * credential of its own — but the connect is finished only for the signed-in person who started
 * it (`MailboxesService.finishConnect`). The answer is always a redirect to the web app's mailbox
 * screen with one result code (`MailboxConnectResult`) and never a token or a Google error text.
 */
@ApiTags('mail')
@ApiExtraModels()
@Controller('mail/oauth')
export class MailOAuthCallbackController {
    constructor(
        private readonly mailboxes: MailboxesService,
        @Inject(ENV) private readonly env: Env,
    ) {}

    @Public()
    @Get('callback')
    @Redirects()
    async callback(
        @Req() req: AuthenticatedRequest,
        @Query() query: OAuthCallbackQueryDto,
        @Res() res: Response,
    ): Promise<void> {
        const caller = req.principal?.kind === 'user' ? req.principal.userId : null;
        res.redirect(this.target(await this.mailboxes.finishConnect(caller, query)));
    }

    private target(outcome: ConnectOutcome): string {
        const path = outcome.workspaceId ? `/w/${outcome.workspaceId}/mailboxes` : '/workspaces';
        const url = new URL(path, this.env.WEB_URL);
        url.searchParams.set(MAILBOX_CONNECT_RESULT_PARAM, mailboxConnectResult.parse(outcome.result));
        return url.toString();
    }
}
