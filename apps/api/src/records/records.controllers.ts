import { Body, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { BulkResult } from '@bylinecrm/shared';
import { BulkBodyDto, ExportBodyDto, ExportQueryDto, GroupByQueryDto, QueryBodyDto } from '../query/dto';
import { ExportService } from '../query/export.service';
import type { Group } from '../query/group-by';
import { QueryService } from '../query/query.service';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { BulkService } from './bulk/bulk.service';
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
import type { CountedPage } from './list-query';
import { PeopleService, type PersonView } from './people.service';
import { Returns, ReturnsFile } from '../openapi/responses';
import { groupView } from '../query/responses';
import { bulkResultView, companyPage, companyView, customFieldView, personPage, personView } from './responses';

/**
 * Records live under `/api/w/:workspaceId`, so the workspace guard has already placed the caller;
 * `@Requires` names what they must be allowed to do. The trash is a route of its own rather than a
 * query flag so its gate (`record:write`) is declared the same way as every other.
 */
@ApiTags('people')
@TenantController('people')
export class PeopleController {
    constructor(
        private readonly people: PeopleService,
        private readonly queries: QueryService,
        private readonly exports: ExportService,
        private readonly bulkActions: BulkService,
    ) {}

    /** The list's twin for a filter too long for a query string: the same parameters in a body. */
    @Requires('record:read')
    @HttpCode(200)
    @Post('query')
    @Returns(personPage)
    query(@Body() body: QueryBodyDto): Promise<CountedPage<PersonView>> {
        return this.people.list(body);
    }

    /** Counts (and money sums) per value of one field over the filtered, scoped list. */
    @Requires('record:read')
    @Get('group-by')
    @Returns([groupView])
    groupBy(@Query() query: GroupByQueryDto): Promise<Group[]> {
        return this.queries.groupBy('person', query);
    }

    /**
     * Many records at once (P1-4a): assign an owner, delete or restore — named by id or selected
     * by filter / view / q, at most `BULK_MAX_IDS`. Each goes through the single-record write and
     * is announced by its own event; the result says, per record, whether it changed.
     */
    @Requires('record:write')
    @HttpCode(200)
    @Post('bulk')
    @Returns(bulkResultView)
    bulk(@Body() body: BulkBodyDto): Promise<BulkResult> {
        return this.bulkActions.run(this.people, body);
    }

    /** The export's twin for a filter too long for a query string — a selection of ids, typically. */
    @Requires('record:read')
    @HttpCode(200)
    @Post('export.csv')
    @Header('Content-Type', 'text/csv; charset=utf-8')
    @Header('Content-Disposition', 'attachment; filename="persons.csv"')
    @Header('Cache-Control', 'private, no-store')
    @ReturnsFile('text/csv')
    async exportCsvSelection(@Body() body: ExportBodyDto, @Res() res: Response): Promise<void> {
        await this.exports.writeCsv('person', body, res);
        res.end();
    }

    /** The filtered, scoped list as a streamed CSV (RFC 4180, UTF-8 with BOM); `413` past `EXPORT_MAX_ROWS`. */
    @Requires('record:read')
    @Get('export.csv')
    @Header('Content-Type', 'text/csv; charset=utf-8')
    @Header('Content-Disposition', 'attachment; filename="persons.csv"')
    @Header('Cache-Control', 'private, no-store')
    @ReturnsFile('text/csv')
    async exportCsv(@Query() query: ExportQueryDto, @Res() res: Response): Promise<void> {
        await this.exports.writeCsv('person', query, res);
        res.end();
    }

    @Requires('record:read')
    @Get()
    @Returns(personPage)
    list(@Query() query: ListQueryDto): Promise<CountedPage<PersonView>> {
        return this.people.list(query);
    }

    @Requires('record:write')
    @Get('deleted')
    @Returns(personPage)
    listDeleted(@Query() query: ListQueryDto): Promise<CountedPage<PersonView>> {
        return this.people.list(query, true);
    }

    @Requires('record:read')
    @Get(':personId')
    @Returns(personView)
    get(@Param('personId', ParseUUIDPipe) personId: string): Promise<PersonView> {
        return this.people.get(personId);
    }

    @Requires('record:write')
    @Post()
    @Returns(personView)
    create(@Body() body: CreatePersonDto): Promise<PersonView> {
        return this.people.create(body);
    }

    @Requires('record:write')
    @Patch(':personId')
    @Returns(personView)
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
    @Returns(personView)
    restore(@Param('personId', ParseUUIDPipe) personId: string): Promise<PersonView> {
        return this.people.restore(personId);
    }
}

@ApiTags('companies')
@TenantController('companies')
export class CompaniesController {
    constructor(
        private readonly companies: CompaniesService,
        private readonly queries: QueryService,
        private readonly exports: ExportService,
        private readonly bulkActions: BulkService,
    ) {}

    /** The list's twin for a filter too long for a query string: the same parameters in a body. */
    @Requires('record:read')
    @HttpCode(200)
    @Post('query')
    @Returns(companyPage)
    query(@Body() body: QueryBodyDto): Promise<CountedPage<CompanyView>> {
        return this.companies.list(body);
    }

    /** Counts (and money sums) per value of one field over the filtered, scoped list. */
    @Requires('record:read')
    @Get('group-by')
    @Returns([groupView])
    groupBy(@Query() query: GroupByQueryDto): Promise<Group[]> {
        return this.queries.groupBy('company', query);
    }

    /**
     * Many records at once (P1-4a): assign an owner, delete or restore — named by id or selected
     * by filter / view / q, at most `BULK_MAX_IDS`. Each goes through the single-record write and
     * is announced by its own event; the result says, per record, whether it changed.
     */
    @Requires('record:write')
    @HttpCode(200)
    @Post('bulk')
    @Returns(bulkResultView)
    bulk(@Body() body: BulkBodyDto): Promise<BulkResult> {
        return this.bulkActions.run(this.companies, body);
    }

    /** The export's twin for a filter too long for a query string — a selection of ids, typically. */
    @Requires('record:read')
    @HttpCode(200)
    @Post('export.csv')
    @Header('Content-Type', 'text/csv; charset=utf-8')
    @Header('Content-Disposition', 'attachment; filename="companys.csv"')
    @Header('Cache-Control', 'private, no-store')
    @ReturnsFile('text/csv')
    async exportCsvSelection(@Body() body: ExportBodyDto, @Res() res: Response): Promise<void> {
        await this.exports.writeCsv('company', body, res);
        res.end();
    }

    /** The filtered, scoped list as a streamed CSV (RFC 4180, UTF-8 with BOM); `413` past `EXPORT_MAX_ROWS`. */
    @Requires('record:read')
    @Get('export.csv')
    @Header('Content-Type', 'text/csv; charset=utf-8')
    @Header('Content-Disposition', 'attachment; filename="companys.csv"')
    @Header('Cache-Control', 'private, no-store')
    @ReturnsFile('text/csv')
    async exportCsv(@Query() query: ExportQueryDto, @Res() res: Response): Promise<void> {
        await this.exports.writeCsv('company', query, res);
        res.end();
    }

    @Requires('record:read')
    @Get()
    @Returns(companyPage)
    list(@Query() query: ListQueryDto): Promise<CountedPage<CompanyView>> {
        return this.companies.list(query);
    }

    @Requires('record:write')
    @Get('deleted')
    @Returns(companyPage)
    listDeleted(@Query() query: ListQueryDto): Promise<CountedPage<CompanyView>> {
        return this.companies.list(query, true);
    }

    @Requires('record:read')
    @Get(':companyId')
    @Returns(companyView)
    get(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<CompanyView> {
        return this.companies.get(companyId);
    }

    @Requires('record:write')
    @Post()
    @Returns(companyView)
    create(@Body() body: CreateCompanyDto): Promise<CompanyView> {
        return this.companies.create(body);
    }

    @Requires('record:write')
    @Patch(':companyId')
    @Returns(companyView)
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
    @Returns(companyView)
    restore(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<CompanyView> {
        return this.companies.restore(companyId);
    }
}

/** Definitions are schema: any member reads them (the record page needs labels), an admin changes them. */
@ApiTags('custom-fields')
@TenantController('custom-fields')
export class CustomFieldsController {
    constructor(private readonly customFields: CustomFieldsService) {}

    @Requires('record:read')
    @Get()
    @Returns([customFieldView])
    list(@Query() query: ListCustomFieldsQueryDto): Promise<CustomFieldView[]> {
        return this.customFields.list(query);
    }

    @Requires('workspace:admin')
    @Post()
    @Returns(customFieldView)
    create(@Body() body: CreateCustomFieldDto): Promise<CustomFieldView> {
        return this.customFields.create(body);
    }

    @Requires('workspace:admin')
    @Patch(':fieldId')
    @Returns(customFieldView)
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

    /** Un-archives: the key is accepted on records again (P1-2b). */
    @Requires('workspace:admin')
    @Post(':fieldId/restore')
    @Returns(customFieldView)
    restore(@Param('fieldId', ParseUUIDPipe) fieldId: string): Promise<CustomFieldView> {
        return this.customFields.restore(fieldId);
    }
}
