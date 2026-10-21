import { Body, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CONTACT_STATUSES, WON_EXCLUSION_SCOPES, type CustomerExclusionSettingsView } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Requires, TenantController } from '../auth/decorators';
import { named, Returns } from '../openapi/responses';
import { personView, type PersonView } from '../records/responses';
import { ContactStatusService } from './contact-status.service';
import { WonDealExclusions } from './won-deal-exclusions';

export class SetContactStatusDto extends createZodDto(
    z.object({
        status: z.enum(CONTACT_STATUSES).nullable().meta({
            description:
                'The status to show whatever is derived; `null` clears it. `do_not_contact` suppresses the primary address instead (needs `outreach:write`); lift the suppression to end it.',
        }),
    }),
) {}

const scope = () =>
    z.enum(WON_EXCLUSION_SCOPES).meta({
        description:
            '`address`: a won deal excludes its point of contact’s primary address. `domain`: their company’s domain (free-mail domains fall back to the address).',
    });
export class CustomerExclusionSettingsDto extends createZodDto(z.object({ wonExclusionScope: scope() })) {}
export const customerExclusionSettingsView = named(
    'CustomerExclusionSettings',
    z.object({ wonExclusionScope: scope() }),
);

@ApiTags('people')
@TenantController('people')
export class ContactStatusController {
    constructor(private readonly statuses: ContactStatusService) {}

    /** #242: set a person's contact status by hand, or clear it. */
    @Requires('record:write')
    @Put(':personId/contact-status')
    @Returns(personView)
    set(@Param('personId', ParseUUIDPipe) personId: string, @Body() body: SetContactStatusDto): Promise<PersonView> {
        return this.statuses.set(personId, body.status);
    }
}

@ApiTags('sequences')
@TenantController('outreach')
export class CustomerExclusionSettingsController {
    constructor(private readonly won: WonDealExclusions) {}

    @Requires('workspace:admin')
    @Get('customer-exclusion-settings')
    @Returns(customerExclusionSettingsView)
    get(): Promise<CustomerExclusionSettingsView> {
        return this.won.settings();
    }

    @Requires('workspace:admin')
    @Put('customer-exclusion-settings')
    @Returns(customerExclusionSettingsView)
    set(@Body() body: CustomerExclusionSettingsDto): Promise<CustomerExclusionSettingsView> {
        return this.won.setSettings(body);
    }
}
