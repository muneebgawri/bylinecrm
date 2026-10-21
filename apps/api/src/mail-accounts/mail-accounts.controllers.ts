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
import { MAILBOX_CONNECT_PURPOSE_PARAM, MAILBOX_CONNECT_RESULT_PARAM } from '@bylinecrm/shared';
import type { Response } from 'express';
import { Public, Requires, TenantController } from '../auth/decorators';
import type { AuthenticatedRequest } from '../auth/principal';
import { ENV, type Env } from '../config/env';
import { Redirects, Returns } from '../openapi/responses';
import {
    ConnectMailboxDto,
    OAuthCallbackQueryDto,
    PatchDelegationDto,
    PutDelegationKeyDto,
    PutDelegationMemberDto,
    PutOAuthClientDto,
    UpdateMailboxDto,
} from './dto';
import { DelegationService } from './delegation.service';
import { MailboxesService, type ConnectOutcome } from './mailboxes.service';
import { OAuthClientsService } from './oauth-clients.service';
import {
    delegationAuditEntry,
    delegationMember,
    delegationView,
    type DelegationAuditEntry,
    type DelegationMember,
    type DelegationView,
    connectStart,
    mailboxCheck,
    mailboxConnectResult,
    mailboxDisconnected,
    mailboxView,
    oauthClientStatus,
    oauthClientView,
    type ConnectStart,
    type MailboxCheck,
    type MailboxDisconnected,
    type MailboxView,
    type OAuthClientStatus,
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

    /**
     * Whether Google is set up and proven, for any member connecting a mailbox (doc 50 §E: "Your
     * admin has set up Google; connect your mailbox below"). No client ID, nothing about the secret.
     */
    @Requires('mailbox:read')
    @Get('status')
    @Returns(oauthClientStatus)
    status(): Promise<OAuthClientStatus> {
        return this.clients.status();
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

/**
 * The workspace's Google Workspace service account with domain-wide delegation (#225). Administrators
 * only: the key can read every member's mail. The key is write-only — no route returns it.
 */
@ApiTags('mail')
@TenantController('mail/google-workspace')
export class DelegationController {
    constructor(private readonly delegation: DelegationService) {}

    /** The setup screen: the service account's email and client ID, the scopes to authorise, the last check. */
    @Requires('workspace:admin')
    @Get()
    @Returns(delegationView)
    describe(): Promise<DelegationView> {
        return this.delegation.describe();
    }

    /** The allowed domains: only members whose address is in one of them sync through the service account. */
    @Requires('workspace:admin')
    @Patch()
    @Returns(delegationView)
    update(@Body() body: PatchDelegationDto): Promise<DelegationView> {
        return this.delegation.setDomains(body.allowedDomains);
    }

    /** Stores the service account's JSON key, sealed, and checks it at once. */
    @Requires('workspace:admin')
    @Put('key')
    @Returns(delegationView)
    putKey(@Body() body: PutDelegationKeyDto): Promise<DelegationView> {
        return this.delegation.putKey(body.key);
    }

    /** Removes the key; every delegated mailbox stops syncing. */
    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('key')
    removeKey(): Promise<void> {
        return this.delegation.removeKey();
    }

    /** Mints a token for the caller's own address, once per scope, and records which scopes are authorised. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('check')
    @Returns(delegationView)
    check(): Promise<DelegationView> {
        return this.delegation.check();
    }

    @Requires('workspace:admin')
    @Get('members')
    @Returns([delegationMember])
    members(): Promise<DelegationMember[]> {
        return this.delegation.members();
    }

    /** Excludes a member from delegation, or includes them again. */
    @Requires('workspace:admin')
    @Put('members/:memberId')
    @Returns(delegationMember)
    setMember(
        @Param('memberId', ParseUUIDPipe) memberId: string,
        @Body() body: PutDelegationMemberDto,
    ): Promise<DelegationMember> {
        return this.delegation.setExcluded(memberId, body.excluded);
    }

    /** The latest audit entries: key and setting changes, checks, and delegated sync starts. */
    @Requires('workspace:admin')
    @Get('audit')
    @Returns([delegationAuditEntry])
    audit(): Promise<DelegationAuditEntry[]> {
        return this.delegation.auditLog();
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
 * screen with one result code (`MailboxConnectResult`) and what the connect was for (a mailbox
 * purpose, or `postmaster`, #129) — never a token or a Google error text.
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
        if (outcome.purpose) url.searchParams.set(MAILBOX_CONNECT_PURPOSE_PARAM, outcome.purpose);
        return url.toString();
    }
}
