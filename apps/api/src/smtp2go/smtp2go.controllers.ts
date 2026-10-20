import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Smtp2GoHookResult } from '@bylinecrm/shared';
import type { Request } from 'express';
import { Public, Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { AddSmtp2GoMailboxDto, PutSmtp2GoKeyDto } from './dto';
import { smtp2goHookResult, smtp2goMailboxView, type Smtp2GoMailboxView } from './responses';
import { Smtp2GoHookService } from './smtp2go-hook.service';
import { Smtp2GoMailboxesService } from './smtp2go-mailboxes.service';
import { SMTP2GO_HOOK_PATH } from './smtp2go.constants';

/**
 * SMTP2Go pool mailboxes (TRANS-1): administrators only — the API key sends the workspace's outreach, and the
 * hook secret proves SMTP2Go's reports. The mailboxes themselves are listed, labelled and disconnected through
 * `/mailboxes` like any other.
 */
@ApiTags('mail')
@TenantController('smtp2go/mailboxes')
export class PoolSmtpMailboxesController {
    constructor(private readonly mailboxes: Smtp2GoMailboxesService) {}

    @Requires('workspace:admin')
    @Get()
    @Returns([smtp2goMailboxView])
    list(): Promise<Smtp2GoMailboxView[]> {
        return this.mailboxes.list();
    }

    /** Adds an SMTP2Go pool mailbox (or connects a disconnected one again); the key is never shown back. */
    @Requires('workspace:admin')
    @HttpCode(201)
    @Post()
    @Returns(smtp2goMailboxView)
    add(@Body() body: AddSmtp2GoMailboxDto): Promise<Smtp2GoMailboxView> {
        return this.mailboxes.add(body);
    }

    @Requires('workspace:admin')
    @Put(':mailboxId/api-key')
    @Returns(smtp2goMailboxView)
    putKey(
        @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
        @Body() body: PutSmtp2GoKeyDto,
    ): Promise<Smtp2GoMailboxView> {
        return this.mailboxes.replaceKey(mailboxId, body.apiKey);
    }

    /** A new hook secret: the old one stops working at once. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post(':mailboxId/rotate-secret')
    @Returns(smtp2goMailboxView)
    rotate(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<Smtp2GoMailboxView> {
        return this.mailboxes.rotateSecret(mailboxId);
    }
}

/** Where SMTP2Go posts a pool mailbox's events: public; the mailbox's hook secret in `Authorization` proves it. */
@ApiTags('mail')
@Controller(SMTP2GO_HOOK_PATH.replace(/^\/api\//, ''))
@Public()
export class PoolSmtpHookController {
    constructor(private readonly hook: Smtp2GoHookService) {}

    @HttpCode(200)
    @Post(':mailboxId')
    @Returns(smtp2goHookResult)
    async receive(
        @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
        @Headers('authorization') authorization: string | undefined,
        @Req() req: Request,
        @Body() body: unknown,
    ): Promise<{ result: Smtp2GoHookResult }> {
        return { result: await this.hook.receive(mailboxId, authorization, body, req.ip ?? '') };
    }
}
