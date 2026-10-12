import { Body, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
    ENRICHMENT_OBJECTS,
    type EnrichmentHistoryView,
    type EnrichmentObject,
    type EnrichmentSettingsView,
} from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { ValidationFailed } from '../infra/errors/api-errors';
import { Returns } from '../openapi/responses';
import { PutEnrichmentSettingsDto } from './dto';
import { EnrichmentService } from './enrichment.service';
import { EnrichmentSettingsService } from './enrichment-settings.service';
import { enrichmentHistoryView, enrichmentSettingsView } from './responses';

/**
 * Enrichment (P4-2, FR-CRMS-15): the workspace's sources and re-ask age (read with record rights, set
 * by an admin), a record's answers, and _Enrich now_. `:object` is `person` or `company`.
 */
@ApiTags('enrichment')
@TenantController('enrichment')
export class EnrichmentController {
    constructor(
        private readonly enrichment: EnrichmentService,
        private readonly settings: EnrichmentSettingsService,
    ) {}

    @Requires('record:read')
    @Get('settings')
    @Returns(enrichmentSettingsView)
    getSettings(): Promise<EnrichmentSettingsView> {
        return this.settings.settings();
    }

    @Requires('workspace:admin')
    @Put('settings')
    @Returns(enrichmentSettingsView)
    putSettings(@Body() body: PutEnrichmentSettingsDto): Promise<EnrichmentSettingsView> {
        return this.settings.putSettings(body);
    }

    @Requires('record:read')
    @Get(':object/:recordId')
    @Returns(enrichmentHistoryView)
    history(
        @Param('object') object: string,
        @Param('recordId', ParseUUIDPipe) recordId: string,
    ): Promise<EnrichmentHistoryView> {
        return this.enrichment.history(enrichmentObject(object), recordId);
    }

    /** Queues the record's run with every source asked again; the answer is the history, `pending`. */
    @Requires('record:write')
    @HttpCode(202)
    @Post(':object/:recordId')
    @Returns(enrichmentHistoryView)
    enrichNow(
        @Param('object') object: string,
        @Param('recordId', ParseUUIDPipe) recordId: string,
    ): Promise<EnrichmentHistoryView> {
        return this.enrichment.request(enrichmentObject(object), recordId);
    }
}

/** The `:object` segment: a person or a company; anything else is refused with the segment named. */
function enrichmentObject(value: string): EnrichmentObject {
    if ((ENRICHMENT_OBJECTS as readonly string[]).includes(value)) return value as EnrichmentObject;
    throw new ValidationFailed('not an enrichable object', [
        { path: 'object', message: `one of ${ENRICHMENT_OBJECTS.join(', ')}` },
    ]);
}
