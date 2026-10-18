import { Body, Delete, HttpCode, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PoolMailboxHealth, SendingDomainView, SendingPoolSettings, SendingPoolView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { connectStart, type ConnectStart } from '../mail-accounts/responses';
import { Returns } from '../openapi/responses';
import { ResumeMailboxDto, SetMailboxPoolDto, UpdateSendingDomainDto, UpdateSendingPoolSettingsDto } from './dto';
import { PostmasterService } from './postmaster.service';
import { poolMailboxHealth, sendingDomainView, sendingPoolSettings, sendingPoolView } from './responses';
import { SendingDomainsService } from './sending-domains.service';
import { SendingPoolService } from './sending-pool.service';

/**
 * The sending pool (P3-2): its health is `outreach:write`'s to read — the people who run outreach
 * see why a mailbox is not sending; the settings, and the Postmaster Tools account (#129), are an
 * admin's.
 */
@ApiTags('sending-pool')
@TenantController('sending-pool')
export class SendingPoolController {
    constructor(
        private readonly pool: SendingPoolService,
        private readonly postmaster: PostmasterService,
        private readonly mailboxes: MailboxesService,
    ) {}

    @Requires('outreach:write')
    @Get()
    @Returns(sendingPoolView)
    view(): Promise<SendingPoolView> {
        return this.pool.view();
    }

    @Requires('workspace:admin')
    @Put('settings')
    @Returns(sendingPoolSettings)
    updateSettings(@Body() body: UpdateSendingPoolSettingsDto): Promise<SendingPoolSettings> {
        return this.pool.updateSettings(body);
    }

    /**
     * Starts connecting the workspace's Postmaster Tools account through its own OAuth client, with
     * Postmaster's scopes only; send the browser to `authorizeUrl`. Google returns it to the mail
     * OAuth callback, which lands on the Mailboxes page with the result. Connecting again replaces it.
     */
    @Requires('workspace:admin')
    @HttpCode(201)
    @Post('postmaster/connect')
    @Returns(connectStart)
    connectPostmaster(): Promise<ConnectStart> {
        return this.mailboxes.startConnect('postmaster');
    }

    /** Revokes the grant at Google and removes the connection; `404` while none is connected. */
    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('postmaster')
    disconnectPostmaster(): Promise<void> {
        return this.postmaster.remove();
    }
}

/** A pool mailbox's own cap, and resuming one the pool paused — an admin's. */
@ApiTags('sending-pool')
@TenantController('mailboxes')
export class PoolMailboxesController {
    constructor(private readonly pool: SendingPoolService) {}

    @Requires('workspace:admin')
    @Put(':mailboxId/pool')
    @Returns(poolMailboxHealth)
    setCap(
        @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
        @Body() body: SetMailboxPoolDto,
    ): Promise<PoolMailboxHealth> {
        return this.pool.setMailboxCap(mailboxId, body.dailyCap);
    }

    @Requires('workspace:admin')
    @HttpCode(200)
    @Post(':mailboxId/resume')
    @Returns(poolMailboxHealth)
    resume(
        @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
        @Body() body: ResumeMailboxDto,
    ): Promise<PoolMailboxHealth> {
        return this.pool.resume(mailboxId, body.note);
    }
}

/**
 * Sending domains and their checks (FR-CRMS-13, #190): every connected mailbox's domain, pool or
 * personal, and every domain the connected Postmaster Tools account lists. The list is for whoever
 * reads the pool; one domain's page, its selector and a check on demand are an admin's.
 */
@ApiTags('sending-pool')
@TenantController('sending-domains')
export class SendingDomainsController {
    constructor(private readonly domains: SendingDomainsService) {}

    @Requires('outreach:write')
    @Get()
    @Returns([sendingDomainView])
    list(): Promise<SendingDomainView[]> {
        return this.domains.list();
    }

    @Requires('workspace:admin')
    @Get(':domainId')
    @Returns(sendingDomainView)
    get(@Param('domainId', ParseUUIDPipe) domainId: string): Promise<SendingDomainView> {
        return this.domains.get(domainId);
    }

    @Requires('workspace:admin')
    @Put(':domainId')
    @Returns(sendingDomainView)
    update(
        @Param('domainId', ParseUUIDPipe) domainId: string,
        @Body() body: UpdateSendingDomainDto,
    ): Promise<SendingDomainView> {
        return this.domains.update(domainId, body.dkimSelector);
    }

    @Requires('workspace:admin')
    @HttpCode(200)
    @Post(':domainId/check')
    @Returns(sendingDomainView)
    check(@Param('domainId', ParseUUIDPipe) domainId: string): Promise<SendingDomainView> {
        return this.domains.check(domainId);
    }
}
