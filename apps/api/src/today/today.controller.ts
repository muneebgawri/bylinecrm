import { Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { TodayQueryDto, TodaySectionQueryDto } from './dto';
import {
    todayDeals,
    todayLeads,
    todayReplies,
    todayTasks,
    todayView,
    type TodayDealsView,
    type TodayLeadsView,
    type TodayRepliesView,
    type TodayTasksView,
    type TodayView,
} from './responses';
import { TodayService } from './today.service';

/**
 * Today (#360): one member's day — their own, or (an admin) any member's. Every section is counted up to
 * `LIST_COUNT_CAP` and paged by its own cursor, the row waiting longest first.
 */
@ApiTags('today')
@TenantController('today')
export class TodayController {
    constructor(private readonly today: TodayService) {}

    @ApiOperation({
        summary: 'Every Today section: its count and first page.',
        description:
            '`replies`: conversations of the last `windows.replyDays` whose latest message is inbound from one of the member’s people, or the contact of one of their open deals — oldest first. `followUps`: open deals whose cadence or planned follow-up falls due by the end of today, most overdue first. `newLeads`: the member’s people made in the last `windows.newLeadDays` whose contact status is still `new`, oldest first. `tasks`: open tasks assigned to them due by the end of today, most overdue first. `stalled`: open deals with nothing due, no follow-up planned and no activity for `windows.stalledDays`, quietest first.',
    })
    @Requires('record:read')
    @Get()
    @Returns(todayView)
    overview(@Query() query: TodayQueryDto): Promise<TodayView> {
        return this.today.overview(query);
    }

    @ApiOperation({ summary: 'Replies waiting: the next page.' })
    @Requires('record:read')
    @Get('replies')
    @Returns(todayReplies)
    replies(@Query() query: TodaySectionQueryDto): Promise<TodayRepliesView> {
        return this.today.section('replies', query);
    }

    @ApiOperation({ summary: 'Follow-ups due: the next page.' })
    @Requires('record:read')
    @Get('follow-ups')
    @Returns(todayDeals)
    followUps(@Query() query: TodaySectionQueryDto): Promise<TodayDealsView> {
        return this.today.section('followUps', query);
    }

    @ApiOperation({ summary: 'New leads not yet contacted: the next page.' })
    @Requires('record:read')
    @Get('new-leads')
    @Returns(todayLeads)
    newLeads(@Query() query: TodaySectionQueryDto): Promise<TodayLeadsView> {
        return this.today.section('newLeads', query);
    }

    @ApiOperation({ summary: 'Tasks due today or overdue: the next page.' })
    @Requires('record:read')
    @Get('tasks')
    @Returns(todayTasks)
    tasks(@Query() query: TodaySectionQueryDto): Promise<TodayTasksView> {
        return this.today.section('tasks', query);
    }

    @ApiOperation({ summary: 'Stalled deals: the next page.' })
    @Requires('record:read')
    @Get('stalled')
    @Returns(todayDeals)
    stalled(@Query() query: TodaySectionQueryDto): Promise<TodayDealsView> {
        return this.today.section('stalled', query);
    }
}
