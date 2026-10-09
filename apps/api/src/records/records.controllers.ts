import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires } from '../auth/decorators';
import { CompaniesService, type CompanyView } from './companies.service';
import { CustomFieldsService, type CustomFieldView } from './custom-fields/custom-fields.service';
import {
    CreateCompanyDto,
    CreateCustomFieldDto,
    CreatePersonDto,
    ListCustomFieldsQueryDto,
    ListQueryDto,
    UpdateCompanyDto,
    UpdateCustomFieldDto,
    UpdatePersonDto,
} from './dto';
import type { Page } from './list-query';
import { PeopleService, type PersonView } from './people.service';

/**
 * Records live under `/api/w/:workspaceId`, so the workspace guard has already placed the caller;
 * `@Requires` names what they must be allowed to do. The trash is a route of its own rather than a
 * query flag so its gate (`record:write`) is declared the same way as every other.
 */
@ApiTags('people')
@Controller('w/:workspaceId/people')
export class PeopleController {
    constructor(private readonly people: PeopleService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListQueryDto): Promise<Page<PersonView>> {
        return this.people.list(query);
    }

    @Requires('record:write')
    @Get('deleted')
    listDeleted(@Query() query: ListQueryDto): Promise<Page<PersonView>> {
        return this.people.list(query, true);
    }

    @Requires('record:read')
    @Get(':personId')
    get(@Param('personId', ParseUUIDPipe) personId: string): Promise<PersonView> {
        return this.people.get(personId);
    }

    @Requires('record:write')
    @Post()
    create(@Body() body: CreatePersonDto): Promise<PersonView> {
        return this.people.create(body);
    }

    @Requires('record:write')
    @Patch(':personId')
    update(@Param('personId', ParseUUIDPipe) personId: string, @Body() body: UpdatePersonDto): Promise<PersonView> {
        return this.people.update(personId, body);
    }

    @Requires('record:write')
    @HttpCode(204)
    @Delete(':personId')
    remove(@Param('personId', ParseUUIDPipe) personId: string): Promise<void> {
        return this.people.remove(personId);
    }

    @Requires('record:write')
    @Post(':personId/restore')
    restore(@Param('personId', ParseUUIDPipe) personId: string): Promise<PersonView> {
        return this.people.restore(personId);
    }
}

@ApiTags('companies')
@Controller('w/:workspaceId/companies')
export class CompaniesController {
    constructor(private readonly companies: CompaniesService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListQueryDto): Promise<Page<CompanyView>> {
        return this.companies.list(query);
    }

    @Requires('record:write')
    @Get('deleted')
    listDeleted(@Query() query: ListQueryDto): Promise<Page<CompanyView>> {
        return this.companies.list(query, true);
    }

    @Requires('record:read')
    @Get(':companyId')
    get(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<CompanyView> {
        return this.companies.get(companyId);
    }

    @Requires('record:write')
    @Post()
    create(@Body() body: CreateCompanyDto): Promise<CompanyView> {
        return this.companies.create(body);
    }

    @Requires('record:write')
    @Patch(':companyId')
    update(@Param('companyId', ParseUUIDPipe) companyId: string, @Body() body: UpdateCompanyDto): Promise<CompanyView> {
        return this.companies.update(companyId, body);
    }

    @Requires('record:write')
    @HttpCode(204)
    @Delete(':companyId')
    remove(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<void> {
        return this.companies.remove(companyId);
    }

    @Requires('record:write')
    @Post(':companyId/restore')
    restore(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<CompanyView> {
        return this.companies.restore(companyId);
    }
}

/** Definitions are schema: any member reads them (the record page needs labels), an admin changes them. */
@ApiTags('custom-fields')
@Controller('w/:workspaceId/custom-fields')
export class CustomFieldsController {
    constructor(private readonly customFields: CustomFieldsService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListCustomFieldsQueryDto): Promise<CustomFieldView[]> {
        return this.customFields.list(query);
    }

    @Requires('workspace:admin')
    @Post()
    create(@Body() body: CreateCustomFieldDto): Promise<CustomFieldView> {
        return this.customFields.create(body);
    }

    @Requires('workspace:admin')
    @Patch(':fieldId')
    update(
        @Param('fieldId', ParseUUIDPipe) fieldId: string,
        @Body() body: UpdateCustomFieldDto,
    ): Promise<CustomFieldView> {
        return this.customFields.update(fieldId, body);
    }

    /** Archives: the key stops being accepted; stored values stay (see the design note). */
    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete(':fieldId')
    archive(@Param('fieldId', ParseUUIDPipe) fieldId: string): Promise<void> {
        return this.customFields.archive(fieldId);
    }
}
