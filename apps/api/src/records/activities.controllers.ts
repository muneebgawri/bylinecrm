import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires } from '../auth/decorators';
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
import type { Page } from './list-query';
import { NotesService, type NoteView } from './notes.service';
import { OpportunitiesService, type OpportunityView } from './opportunities.service';
import { parseTarget } from './targets';
import { TasksService, type TaskView } from './tasks.service';

/** Deals: read with `deal:read`, every write with `deal:edit`; moving stages is P1-2's `deal:move`. */
@ApiTags('opportunities')
@Controller('w/:workspaceId/opportunities')
export class OpportunitiesController {
    constructor(private readonly opportunities: OpportunitiesService) {}

    @Requires('deal:read')
    @Get()
    list(@Query() query: ListQueryDto): Promise<Page<OpportunityView>> {
        return this.opportunities.list(query);
    }

    @Requires('deal:edit')
    @Get('deleted')
    listDeleted(@Query() query: ListQueryDto): Promise<Page<OpportunityView>> {
        return this.opportunities.list(query, true);
    }

    @Requires('deal:read')
    @Get(':opportunityId')
    get(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<OpportunityView> {
        return this.opportunities.get(opportunityId);
    }

    @Requires('deal:edit')
    @Post()
    create(@Body() body: CreateOpportunityDto): Promise<OpportunityView> {
        return this.opportunities.create(body);
    }

    @Requires('deal:edit')
    @Patch(':opportunityId')
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
    restore(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<OpportunityView> {
        return this.opportunities.restore(opportunityId);
    }
}

/** Notes on records: reading them is reading the record; writing them is `note:write`. */
@ApiTags('notes')
@Controller('w/:workspaceId/notes')
export class NotesController {
    constructor(private readonly notes: NotesService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListNotesQueryDto): Promise<Page<NoteView>> {
        return this.notes.list({ ...query, target: parseTarget(query.target) });
    }

    @Requires('note:write')
    @Get('deleted')
    listDeleted(@Query() query: ListNotesQueryDto): Promise<Page<NoteView>> {
        return this.notes.list({ ...query, target: parseTarget(query.target) }, true);
    }

    @Requires('record:read')
    @Get(':noteId')
    get(@Param('noteId', ParseUUIDPipe) noteId: string): Promise<NoteView> {
        return this.notes.get(noteId);
    }

    @Requires('note:write')
    @Post()
    create(@Body() body: CreateNoteDto): Promise<NoteView> {
        return this.notes.create(body);
    }

    @Requires('note:write')
    @Patch(':noteId')
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
    restore(@Param('noteId', ParseUUIDPipe) noteId: string): Promise<NoteView> {
        return this.notes.restore(noteId);
    }
}

/** Tasks on records or on a member's plate: reading is `record:read`, writing is `task:write`. */
@ApiTags('tasks')
@Controller('w/:workspaceId/tasks')
export class TasksController {
    constructor(private readonly tasks: TasksService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListTasksQueryDto): Promise<Page<TaskView>> {
        return this.tasks.list({ ...query, target: query.target ? parseTarget(query.target) : undefined });
    }

    @Requires('task:write')
    @Get('deleted')
    listDeleted(@Query() query: ListTasksQueryDto): Promise<Page<TaskView>> {
        return this.tasks.list({ ...query, target: query.target ? parseTarget(query.target) : undefined }, true);
    }

    @Requires('record:read')
    @Get(':taskId')
    get(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<TaskView> {
        return this.tasks.get(taskId);
    }

    @Requires('task:write')
    @Post()
    create(@Body() body: CreateTaskDto): Promise<TaskView> {
        return this.tasks.create(body);
    }

    @Requires('task:write')
    @Patch(':taskId')
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
    restore(@Param('taskId', ParseUUIDPipe) taskId: string): Promise<TaskView> {
        return this.tasks.restore(taskId);
    }
}
