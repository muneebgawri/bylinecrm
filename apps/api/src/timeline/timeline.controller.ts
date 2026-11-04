import { Body, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AnyMember, Requires, TenantController } from '../auth/decorators';
import type { Page } from '../records/list-query';
import { parseTarget } from '../records/targets';
import { ExternalActivityDto, ListTimelineQueryDto } from './dto';
import { TimelineService, type ExternalActivityResult, type TimelineActivityView } from './timeline.service';
import { Returns } from '../openapi/responses';
import { dealFeed, externalActivityResult, timelinePage } from './responses';
import { DealFeedService, type DealFeedItem } from './deal-feed.service';

/**
 * A record's timeline. Reading one is reading the record (`record:read`); an integration adds
 * to one with `record:write`, as a member or through an API key. There is no update or delete:
 * history is appended, never edited.
 */
@ApiTags('timeline')
@TenantController('timeline')
export class TimelineController {
    constructor(private readonly timeline: TimelineService) {}

    @Requires('record:read')
    @Get()
    @Returns(timelinePage)
    list(@Query() query: ListTimelineQueryDto): Promise<Page<TimelineActivityView>> {
        return this.timeline.list({
            target: query.target ? parseTarget(query.target) : undefined,
            kinds: splitKinds(query.kinds),
            cursor: query.cursor,
            limit: query.limit,
        });
    }

    /** Always `201`: the body says whether this call wrote the entry or found it (`created`). */
    @Requires('record:write')
    @HttpCode(201)
    @Post('external')
    @Returns(externalActivityResult)
    external(@Body() body: ExternalActivityDto): Promise<ExternalActivityResult> {
        return this.timeline.recordExternal({
            target: parseTarget(body.target),
            kind: body.kind,
            happenedAt: new Date(body.happenedAt),
            title: body.title,
            url: body.url,
            amount: body.amount,
            source: body.source,
            idempotencyKey: body.idempotencyKey,
        });
    }
}

/** `a,b` → `['a', 'b']`; blanks dropped. */
function splitKinds(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
}

/**
 * The live deal feed: everyone in the workspace sees what the team does with deals — created, moved, won, lost,
 * paid — as headlines, past their own owner scope (`deal:read`). The app polls it.
 */
@ApiTags('timeline')
@TenantController('deal-feed')
export class DealFeedController {
    constructor(private readonly feed: DealFeedService) {}

    @AnyMember("the team's deal headlines are for everyone; opening a deal still needs deal:read and its owner scope")
    @Get()
    @Returns(dealFeed)
    async latest(): Promise<{ items: DealFeedItem[] }> {
        return { items: await this.feed.latest() };
    }
}
