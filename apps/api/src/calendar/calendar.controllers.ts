import { Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { WorkspaceContext } from '../infra/workspace-context';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { CalendarSyncWorkers } from './calendar-sync.workers';
import { ListMeetingsQueryDto, MeetingKpisQueryDto } from './dto';
import { MeetingsService } from './meetings.service';
import {
    calendarSyncTriggered,
    calendarSyncView,
    meetingKpis,
    meetingPage,
    type CalendarSyncTriggered,
    type CalendarSyncView,
    type MeetingKpis,
    type MeetingView,
} from './responses';

/** Meetings from members' calendars (CAL-1), and each member's meeting KPIs. */
@ApiTags('calendar')
@TenantController('meetings')
export class MeetingsController {
    constructor(private readonly meetings: MeetingsService) {}

    /** Meetings, newest first: every member's for an admin (or one member's, `memberId`), the caller's own otherwise. */
    @Requires('record:read')
    @Get()
    @Returns(meetingPage)
    list(@Query() query: ListMeetingsQueryDto): Promise<Page<MeetingView>> {
        return this.meetings.list(query);
    }

    /** Meeting KPIs over a period, one row per member: every member for an admin, the caller alone otherwise. */
    @Requires('record:read')
    @Get('kpis')
    @Returns(meetingKpis)
    kpis(@Query() query: MeetingKpisQueryDto): Promise<MeetingKpis> {
        return this.meetings.kpis(query);
    }
}

/** A personal mailbox's calendar sync: where it stands, and asking for a run now. */
@ApiTags('calendar')
@TenantController('mailboxes')
export class CalendarSyncController {
    constructor(
        private readonly meetings: MeetingsService,
        private readonly mailboxes: MailboxesService,
        private readonly workers: CalendarSyncWorkers,
        private readonly context: WorkspaceContext,
    ) {}

    @Requires('mailbox:read')
    @Get(':mailboxId/calendar')
    @Returns(calendarSyncView)
    state(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<CalendarSyncView> {
        return this.meetings.syncState(mailboxId);
    }

    /** Queues a calendar read now (the mailbox's owner or an admin). */
    @Requires('mailbox:manage')
    @HttpCode(202)
    @Post(':mailboxId/calendar/sync')
    @Returns(calendarSyncTriggered)
    async trigger(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<CalendarSyncTriggered> {
        await this.mailboxes.assertChangeable(mailboxId);
        const workspaceId = this.context.get()!.workspaceId;
        const queued = await this.workers.enqueue({ workspaceId, mailboxId });
        return { sync: await this.meetings.syncState(mailboxId), queued };
    }
}
