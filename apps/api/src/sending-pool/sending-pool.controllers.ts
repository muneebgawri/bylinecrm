import { Body, HttpCode, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PoolMailboxHealth, SendingDomainView, SendingPoolSettings, SendingPoolView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { ResumeMailboxDto, SetMailboxPoolDto, UpdateSendingDomainDto, UpdateSendingPoolSettingsDto } from './dto';
import { poolMailboxHealth, sendingDomainView, sendingPoolSettings, sendingPoolView } from './responses';
import { SendingDomainsService } from './sending-domains.service';
import { SendingPoolService } from './sending-pool.service';

/**
 * The sending pool (P3-2): its health is `outreach:write`'s to read — the people who run outreach
 * see why a mailbox is not sending; the settings are an admin's.
 */
@ApiTags('sending-pool')
@TenantController('sending-pool')
export class SendingPoolController {
    constructor(private readonly pool: SendingPoolService) {}

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

/** Sending domains and their DNS checks (FR-CRMS-13). */
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
