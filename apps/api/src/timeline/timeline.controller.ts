import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires } from '../auth/decorators';
import type { Page } from '../records/list-query';
import { parseTarget } from '../records/targets';
import { ExternalActivityDto, ListTimelineQueryDto } from './dto';
import { TimelineService, type ExternalActivityResult, type TimelineActivityView } from './timeline.service';

/**
 * A record's timeline. Reading one is reading the record (`record:read`); an integration adds
 * to one with `record:write`, as a member or through an API key. There is no update or delete:
 * history is appended, never edited.
 */
@ApiTags('timeline')
@Controller('w/:workspaceId/timeline')
export class TimelineController {
    constructor(private readonly timeline: TimelineService) {}

    @Requires('record:read')
    @Get()
    list(@Query() query: ListTimelineQueryDto): Promise<Page<TimelineActivityView>> {
        return this.timeline.list({
            target: parseTarget(query.target),
            kinds: splitKinds(query.kinds),
            cursor: query.cursor,
            limit: query.limit,
        });
    }

    /** Always `201`: the body says whether this call wrote the entry or found it (`created`). */
    @Requires('record:write')
    @HttpCode(201)
    @Post('external')
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
