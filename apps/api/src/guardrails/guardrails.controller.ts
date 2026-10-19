import { Body, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { GuardrailEventView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { ListGuardrailEventsQueryDto, MarkLegitimateDto } from './dto';
import { GuardrailsService } from './guardrails.service';
import { guardrailEventPage, guardrailEventView } from './responses';

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
