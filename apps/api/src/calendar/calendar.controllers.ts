import { Body, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { WorkspaceContext } from '../infra/workspace-context';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { CalendarSyncWorkers } from './calendar-sync.workers';
import {
    LeadSuggestionDecisionDto,
    ListLeadSuggestionsQueryDto,
    ListMeetingsQueryDto,
    MeetingKpisQueryDto,
} from './dto';
import { LeadSuggestionsService } from './lead-suggestions.service';
import { MeetingsService } from './meetings.service';
import {
    calendarSyncTriggered,
    calendarSyncView,
    leadSuggestionAccepted,
    leadSuggestionView,
    meetingKpis,
    meetingPage,
    type CalendarSyncTriggered,
    type CalendarSyncView,
    type LeadSuggestionAccepted,
    type LeadSuggestionView,
    type MeetingKpis,
    type MeetingView,
} from './responses';

/** Meetings from members' calendars (CAL-1), and each member's meeting KPIs. */
@ApiTags('calendar')
@TenantController('meetings')
export class MeetingsController {
    constructor(
        private readonly meetings: MeetingsService,
        private readonly suggestions: LeadSuggestionsService,
    ) {}

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

    /**
     * Meeting attendees suggested as leads (CAL-3), one per address: those sync did not make people because the
     * member was invited by someone outside, or they are at a free-mail domain. A meeting counts only once a
     * person on it is the member's, so these are the member's to add or dismiss.
     */
    @Requires('record:read')
    @Get('lead-suggestions')
    @Returns([leadSuggestionView])
    listSuggestions(@Query() query: ListLeadSuggestionsQueryDto): Promise<LeadSuggestionView[]> {
        return this.suggestions.list(query.memberId);
    }

    /** Adds a suggested lead: a person the member owns (or an unowned one given to them); their meetings count. */
    @Requires('record:write')
    @HttpCode(200)
    @Post('lead-suggestions/accept')
    @Returns(leadSuggestionAccepted)
    acceptSuggestion(@Body() body: LeadSuggestionDecisionDto): Promise<LeadSuggestionAccepted> {
        return this.suggestions.accept(body);
    }

    /** "Not a lead": the address is not suggested to the member again; nothing else changes. */
    @Requires('record:read')
    @HttpCode(204)
    @Post('lead-suggestions/dismiss')
    dismissSuggestion(@Body() body: LeadSuggestionDecisionDto): Promise<void> {
        return this.suggestions.dismiss(body);
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
