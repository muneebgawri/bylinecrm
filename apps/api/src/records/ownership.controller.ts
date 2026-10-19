import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { CompanyDomainView, OwnershipConflictView } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Requires, TenantController } from '../auth/decorators';
import { named, Returns } from '../openapi/responses';
import { companyDomainView, ownershipConflictView } from './responses';
import { OwnershipService } from './ownership.service';

class AddCompanyDomainDto extends createZodDto(z.object({ domain: z.string().trim().min(3).max(253) })) {}

class ResolveConflictsDto extends createZodDto(
    z.object({
        items: z
            .array(z.object({ object: z.enum(['person', 'opportunity']), recordId: z.uuid() }))
            .min(1)
            .max(200),
    }),
) {}

const resolvedView = named(
    'OwnershipResolution',
    z.object({
        resolved: z.array(z.uuid()).meta({ description: 'Records moved to their company’s owner (and linked to it).' }),
        skipped: z.array(z.uuid()).meta({ description: 'Records the report no longer lists.' }),
    }),
);

/** A company's other domains (OWN-2, FR-CRMS-20): a person writing from one is at the company. */
@ApiTags('companies')
@TenantController('companies/:companyId/domains')
export class CompanyDomainsController {
    constructor(private readonly ownership: OwnershipService) {}

    @Requires('record:read')
    @Get()
    @Returns([companyDomainView])
    list(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<CompanyDomainView[]> {
        return this.ownership.domains(companyId);
    }

    /** The company's owner, or a holder of `record:transfer`. */
    @Requires('record:write')
    @Post()
    @Returns(companyDomainView)
    add(
        @Param('companyId', ParseUUIDPipe) companyId: string,
        @Body() body: AddCompanyDomainDto,
    ): Promise<CompanyDomainView> {
        return this.ownership.addDomain(companyId, body.domain);
    }

    @Requires('record:write')
    @HttpCode(204)
    @Delete(':domain')
    remove(@Param('companyId', ParseUUIDPipe) companyId: string, @Param('domain') domain: string): Promise<void> {
        return this.ownership.removeDomain(companyId, domain);
    }
}

/** What the company-ownership rule disagrees with, for a manager to resolve (OWN-2's backfill report). */
@ApiTags('companies')
@TenantController('ownership')
export class OwnershipController {
    constructor(private readonly ownership: OwnershipService) {}

    @Requires('record:transfer')
    @Get('conflicts')
    @Returns([ownershipConflictView])
    conflicts(): Promise<OwnershipConflictView[]> {
        return this.ownership.conflicts();
    }

    /** Moves each named record to its company's owner (a forced transfer each). */
    @Requires('record:transfer')
    @Post('conflicts/resolve')
    @Returns(resolvedView)
    resolve(@Body() body: ResolveConflictsDto): Promise<{ resolved: string[]; skipped: string[] }> {
        return this.ownership.resolve(body.items);
    }
}
