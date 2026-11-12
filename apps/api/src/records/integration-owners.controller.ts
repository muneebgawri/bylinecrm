import { Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { OwnerLookupQueryDto } from './dto';
import { OwnerLookupService, type OwnerLookup } from './owner-lookup.service';
import { ownerLookupView } from './responses';

/**
 * An integration asking who owns someone (OWN-LOOKUP): NewswireOS, with an API key whose role holds
 * `record:owner_lookup`. Read only. A member can hold it too, but no default role does.
 */
@ApiTags('integrations')
@TenantController('integrations/owners')
export class IntegrationOwnersController {
    constructor(private readonly owners: OwnerLookupService) {}

    /** The person with this address and their owner; else their company's (OWN-2). Found / not found, and whose. */
    @Requires('record:owner_lookup')
    @Get('lookup')
    @Returns(ownerLookupView)
    lookup(@Query() query: OwnerLookupQueryDto): Promise<OwnerLookup> {
        return this.owners.lookup(query.email, query.domain ?? null);
    }
}
