import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
    DORMANT_OWNER_MONTHS_LIMITS,
    TRANSFER_COOLING_DAYS_LIMITS,
    type CompanyDomainView,
    type OwnershipConflictView,
    type OwnershipSettingsView,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Requires, TenantController } from '../auth/decorators';
import { named, Returns } from '../openapi/responses';
import { companyDomainView, ownerLoadView, ownershipConflictView, type OwnerLoadView } from './responses';
import { TransfersService } from '../transfers/transfers.service';
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

const ownershipSettingsShape = z.object({
    transferCoolingDays: z
        .number()
        .int()
        .min(TRANSFER_COOLING_DAYS_LIMITS.min)
        .max(TRANSFER_COOLING_DAYS_LIMITS.max)
        .meta({
            description:
                'Days after a transfer during which the record cannot go back to the member it left (not offered to them, not accepted by them). Managers and admins are exempt. 0 turns it off.',
        }),
    dormantOwnerMonths: z
        .number()
        .int()
        .min(DORMANT_OWNER_MONTHS_LIMITS.min)
        .max(DORMANT_OWNER_MONTHS_LIMITS.max)
        .meta({
            description:
                'OWN-2f: months after which a company owner who has not worked it (no open deal, no mail, nothing saved or done there, no hand-over to them) holds it for nobody: its leads are anyone’s, and the next member to save a person there takes it over. 0 turns it off.',
        }),
});
class OwnershipSettingsDto extends createZodDto(ownershipSettingsShape) {}
const ownershipSettingsView = named('OwnershipSettings', ownershipSettingsShape);

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
    constructor(
        private readonly ownership: OwnershipService,
        private readonly transfers: TransfersService,
    ) {}

    /** The transfer cooling period (owner decision 2); every member may read it. */
    @Requires('record:read')
    @Get('settings')
    @Returns(ownershipSettingsView)
    settings(): Promise<OwnershipSettingsView> {
        return this.transfers.settings();
    }

    @Requires('record:transfer')
    @Put('settings')
    @Returns(ownershipSettingsView)
    setSettings(@Body() body: OwnershipSettingsDto): Promise<OwnershipSettingsView> {
        return this.transfers.setSettings(body);
    }

    /** Who holds how many leads (Reports): a manager's view of the team, as the conflicts are. */
    @Requires('record:transfer')
    @Get('load')
    @Returns([ownerLoadView])
    load(): Promise<OwnerLoadView[]> {
        return this.ownership.load();
    }

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
