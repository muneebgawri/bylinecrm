import { Body, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { BulkResult } from '@bylinecrm/shared';
import { BulkBodyDto, ExportBodyDto, ExportQueryDto, GroupByQueryDto, QueryBodyDto } from '../query/dto';
import { ExportService } from '../query/export.service';
import type { Group } from '../query/group-by';
import { QueryService } from '../query/query.service';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { HidesAdminOnlyFields } from './custom-fields/admin-only';
import {
    CreateNoteDto,
    CreateOpportunityDto,
    CreateTaskDto,
    ListNotesQueryDto,
    ListQueryDto,
    ListTasksQueryDto,
    UpdateNoteDto,
    UpdateOpportunityDto,
    UpdateTaskDto,
} from './dto';
import type { CountedPage, Page } from './list-query';
import { BulkService } from './bulk/bulk.service';
import { NotesService, type NoteView } from './notes.service';
import { OpportunitiesService, type OpportunityView } from './opportunities.service';
import { parseTarget } from './targets';
import { TasksService, type TaskView } from './tasks.service';
import { Returns, ReturnsFile } from '../openapi/responses';
import { groupView } from '../query/responses';
import { bulkResultView, notePage, noteView, opportunityPage, opportunityView, taskPage, taskView } from './responses';

/**
 * Deals: read with `deal:read`, every write with `deal:edit`; moving stages is P1-2's `deal:move`;
 * acting on many at once needs `deal:bulk` (doc 50 §B) and `deal:edit`, since each change is an edit.
 */
@ApiTags('opportunities')
@TenantController('opportunities')
@HidesAdminOnlyFields('opportunity')
export class OpportunitiesController {
    constructor(
        private readonly opportunities: OpportunitiesService,
        private readonly queries: QueryService,
        private readonly exports: ExportService,
        private readonly bulkActions: BulkService,
    ) {}

    /** The list's twin for a filter too long for a query string: the same parameters in a body. */
    @Requires('deal:read')
    @HttpCode(200)
    @Post('query')
    @Returns(opportunityPage)
    query(@Body() body: QueryBodyDto): Promise<CountedPage<OpportunityView>> {
        return this.opportunities.list(body);
    }

    /** Counts and amount sums per value of one field over the filtered, scoped list (the board's totals). */
    @Requires('deal:read')
    @Get('group-by')
    @Returns([groupView])
    groupBy(@Query() query: GroupByQueryDto): Promise<Group[]> {
        return this.queries.groupBy('opportunity', query);
    }

    /**
     * Many records at once (P1-4a): assign an owner, delete or restore — named by id or selected
     * by filter / view / q, at most `BULK_MAX_IDS`. Each goes through the single-record write and
     * is announced by its own event; the result says, per record, whether it changed.
     */
    @Requires('deal:bulk', 'deal:edit')
    @HttpCode(200)
    @Post('bulk')
    @Returns(bulkResultView)
    bulk(@Body() body: BulkBodyDto): Promise<BulkResult> {
        return this.bulkActions.run(this.opportunities, body);
    }

    /** The export's twin for a filter too long for a query string — a selection of ids, typically. */
    @Requires('deal:read')
    @HttpCode(200)
    @Post('export.csv')
    @Header('Content-Type', 'text/csv; charset=utf-8')
    @Header('Content-Disposition', 'attachment; filename="opportunitys.csv"')
    @Header('Cache-Control', 'private, no-store')
    @ReturnsFile('text/csv')
    async exportCsvSelection(@Body() body: ExportBodyDto, @Res() res: Response): Promise<void> {
        await this.exports.writeCsv('opportunity', body, res);
        res.end();
    }

    /** The filtered, scoped list as a streamed CSV (RFC 4180, UTF-8 with BOM); `413` past `EXPORT_MAX_ROWS`. */
    @Requires('deal:read')
    @Get('export.csv')
    @Header('Content-Type', 'text/csv; charset=utf-8')
    @Header('Content-Disposition', 'attachment; filename="opportunities.csv"')
    @Header('Cache-Control', 'private, no-store')
    @ReturnsFile('text/csv')
    async exportCsv(@Query() query: ExportQueryDto, @Res() res: Response): Promise<void> {
        await this.exports.writeCsv('opportunity', query, res);
        res.end();
    }

    @Requires('deal:read')
    @Get()
    @Returns(opportunityPage)
    list(@Query() query: ListQueryDto): Promise<CountedPage<OpportunityView>> {
        return this.opportunities.list(query);
    }

    @Requires('deal:edit')
    @Get('deleted')
    @Returns(opportunityPage)
    listDeleted(@Query() query: ListQueryDto): Promise<CountedPage<OpportunityView>> {
        return this.opportunities.list(query, true);
    }

    @Requires('deal:read')
    @Get(':opportunityId')
    @Returns(opportunityView)
    get(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<OpportunityView> {
        return this.opportunities.get(opportunityId);
    }

    @Requires('deal:edit')
    @Post()
    @Returns(opportunityView)
    create(@Body() body: CreateOpportunityDto): Promise<OpportunityView> {
        return this.opportunities.create(body);
    }

    @Requires('deal:edit')
    @Patch(':opportunityId')
    @Returns(opportunityView)
    update(
        @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
        @Body() body: UpdateOpportunityDto,
    ): Promise<OpportunityView> {
        return this.opportunities.update(opportunityId, body);
    }

    @Requires('deal:edit')
    @HttpCode(204)
    @Delete(':opportunityId')
    remove(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<void> {
        return this.opportunities.remove(opportunityId);
    }

    @Requires('deal:edit')
    @Post(':opportunityId/restore')
    @Returns(opportunityView)
    restore(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<OpportunityView> {
        return this.opportunities.restore(opportunityId);
    }
}

/** Notes on records: reading them is reading the record; writing them is `note:write`. */
@ApiTags('notes')
@TenantController('notes')
export class NotesController {
    constructor(private readonly notes: NotesService) {}

    @Requires('record:read')
    @Get()
    @Returns(notePage)
    list(@Query() query: ListNotesQueryDto): Promise<Page<NoteView>> {
        return this.notes.list({ ...query, target: parseTarget(query.target) });
    }

    @Requires('note:write')
    @Get('deleted')
    @Returns(notePage)
    listDeleted(@Query() query: ListNotesQueryDto): Promise<Page<NoteView>> {
        return this.notes.list({ ...query, target: parseTarget(query.target) }, true);
    }

    @Requires('record:read')
    @Get(':noteId')
    @Returns(noteView)
    get(@Param('noteId', ParseUUIDPipe) noteId: string): Promise<NoteView> {
        return this.notes.get(noteId);
    }

    @Requires('note:write')
    @Post()
    @Returns(noteView)
    create(@Body() body: CreateNoteDto): Promise<NoteView> {
        return this.notes.create(body);
    }

    @Requires('note:write')
    @Patch(':noteId')
    @Returns(noteView)
    update(@Param('noteId', ParseUUIDPipe) noteId: string, @Body() body: UpdateNoteDto): Promise<NoteView> {
        return this.notes.update(noteId, body);
    }

    @Requires('note:write')
    @HttpCode(204)
    @Delete(':noteId')
    remove(@Param('noteId', ParseUUIDPipe) noteId: string): Promise<void> {
        return this.notes.remove(noteId);
    }

    @Requires('note:write')
    @Post(':noteId/restore')
    @Returns(noteView)
    restore(@Param('noteId', ParseUUIDPipe) noteId: string): Promise<NoteView> {
        return this.notes.restore(noteId);
    }
}

/** Tasks on records or on a member's plate: reading is `record:read`, writing is `task:write`. */
@ApiTags('tasks')
@TenantController('tasks')
export class TasksController {
    constructor(private readonly tasks: TasksService) {}

    @Requires('record:read')
    @Get()
    @Returns(taskPage)
    list(@Query() query: ListTasksQueryDto): Promise<Page<TaskView>> {
        return this.tasks.list({ ...query, target: query.target ? parseTarget(query.target) : undefined });
    }

    @Requires('task:write')
    @Get('deleted')
    @Returns(taskPage)
    listDeleted(@Query() query: ListTasksQueryDto): Promise<Page<TaskView>> {
        return this.tasks.list({ ...query, target: query.target ? parseTarget(query.target) : undefined }, true);
    }

    @Requires('record:read')
    @Get(':taskId')
    @Returns(taskView)
    get(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<TaskView> {
        return this.tasks.get(taskId);
    }

    @Requires('task:write')
    @Post()
    @Returns(taskView)
    create(@Body() body: CreateTaskDto): Promise<TaskView> {
        return this.tasks.create(body);
    }

    @Requires('task:write')
    @Patch(':taskId')
    @Returns(taskView)
    update(@Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: UpdateTaskDto): Promise<TaskView> {
        return this.tasks.update(taskId, body);
    }

    @Requires('task:write')
    @HttpCode(204)
    @Delete(':taskId')
    remove(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<void> {
        return this.tasks.remove(taskId);
    }

    @Requires('task:write')
    @Post(':taskId/restore')
    @Returns(taskView)
    restore(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<TaskView> {
        return this.tasks.restore(taskId);
    }
}
