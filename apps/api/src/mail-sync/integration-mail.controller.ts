import { Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { SentCountsQueryDto, ServiceMailQueryDto } from './dto';
import { IntegrationMailService } from './integration-mail.service';
import { sentCountsView, serviceMailPage, type SentCountsView, type ServiceMailMessage } from './responses';

/**
 * An integration's reads of synced mail (SVC-1): NewswireOS, with an API key whose role holds these capabilities. A
 * member can hold them too, but no default role does.
 */
@ApiTags('integrations')
@TenantController('integrations/mail')
export class IntegrationMailController {
    constructor(private readonly mail: IntegrationMailService) {}

    /** What service inboxes hold, bodies included, oldest stored first. Never a personal mailbox's mail. */
    @Requires('mail:service_read')
    @Get('service-messages')
    @Returns(serviceMailPage)
    serviceMessages(@Query() query: ServiceMailQueryDto): Promise<Page<ServiceMailMessage>> {
        return this.mail.serviceMessages({
            ...query,
            since: new Date(query.since),
            until: query.until ? new Date(query.until) : undefined,
        });
    }

    /** How much each named sender sent on one UTC day: counts only, mail already sent. */
    @Requires('mail:sent_counts')
    @Get('sent-counts')
    @Returns(sentCountsView)
    sentCounts(@Query() query: SentCountsQueryDto): Promise<SentCountsView> {
        return this.mail.sentCounts(query);
    }
}
