import { Body, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { GuardrailEventView, MailboxCoverageView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { ListGuardrailEventsQueryDto, MarkLegitimateDto } from './dto';
import { GuardrailsService } from './guardrails.service';
import { guardrailEventPage, guardrailEventView, mailboxCoverageView } from './responses';

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
