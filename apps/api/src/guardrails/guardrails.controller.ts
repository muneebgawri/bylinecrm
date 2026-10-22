import { Body, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { GuardrailEventView, GuardrailSettingsView, MailboxCoverageView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { GuardrailSettingsDto, ListGuardrailEventsQueryDto, MarkLegitimateDto } from './dto';
import { GuardrailsService } from './guardrails.service';
import { guardrailEventPage, guardrailEventView, guardrailSettingsView, mailboxCoverageView } from './responses';

/** The Guardrails page (GUARD-1, FR-CRMS-21): what the recipient guard did, for reviewers. */
@ApiTags('guardrails')
@TenantController('guardrails')
export class GuardrailsController {
    constructor(private readonly guardrails: GuardrailsService) {}

    @Requires('guardrail:review')
    @Get('events')
    @Returns(guardrailEventPage)
    list(@Query() query: ListGuardrailEventsQueryDto): Promise<Page<GuardrailEventView>> {
        return this.guardrails.list(query);
    }

    /**
     * GUARD-2: every active member and whether the mail they send is seen by sync — those not seen first. Poaching
     * from a mailbox that is not connected is invisible; this is the list to chase.
     */
    @Requires('guardrail:review')
    @Get('mailbox-coverage')
    @Returns([mailboxCoverageView])
    mailboxCoverage(): Promise<MailboxCoverageView[]> {
        return this.guardrails.mailboxCoverage();
    }

    /** GUARD-2's settings: whether high poaching alerts are emailed at once, and the shared mailboxes. */
    @Requires('guardrail:review')
    @Get('settings')
    @Returns(guardrailSettingsView)
    settings(): Promise<GuardrailSettingsView> {
        return this.guardrails.settings();
    }

    /** Admins only; a shared mailbox that is not a member of the workspace is a `422`. */
    @Requires('workspace:admin')
    @Put('settings')
    @Returns(guardrailSettingsView)
    setSettings(@Body() body: GuardrailSettingsDto): Promise<GuardrailSettingsView> {
        return this.guardrails.setSettings(body);
    }

    /** Marks an event legitimate, with why; once (`409` after). */
    @Requires('guardrail:review')
    @Post('events/:eventId/legitimate')
    @Returns(guardrailEventView)
    markLegitimate(
        @Param('eventId', ParseUUIDPipe) id: string,
        @Body() body: MarkLegitimateDto,
    ): Promise<GuardrailEventView> {
        return this.guardrails.markLegitimate(id, body.reason);
    }
}
