import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public, Requires, TenantController } from '../auth/decorators';
import { Redirects, Returns } from '../openapi/responses';
import type { Page } from '../records/list-query';
import { CreateSuppressionDto, ListSuppressionsQueryDto, RemoveSuppressionDto } from './dto';
import {
    suppressionPage,
    suppressionView,
    unsubscribeStatus,
    type SuppressionView,
    type UnsubscribeStatusView,
} from './responses';
import { UnsubscribeRateGuard } from './unsubscribe-rate.guard';
import { SuppressionService } from './suppression.service';
import { UnsubscribeService } from './unsubscribe.service';

/**
 * The workspace's suppression list (P3-1, FR-CRMS-7). Reading and adding are `outreach:write` — the
 * list is the other half of outreach; lifting a hard bounce or a manual entry is an admin's, with a
 * note. An unsubscribe or a complaint is never lifted here (`409`).
 */
@ApiTags('suppression')
@TenantController('suppressions')
export class SuppressionsController {
    constructor(private readonly suppressions: SuppressionService) {}

    @Requires('outreach:write')
    @Get()
    @Returns(suppressionPage)
    list(@Query() query: ListSuppressionsQueryDto): Promise<Page<SuppressionView>> {
        return this.suppressions.list(query);
    }

    @Requires('outreach:write')
    @Post()
    @Returns(suppressionView)
    add(@Body() body: CreateSuppressionDto): Promise<SuppressionView> {
        return this.suppressions.add(body);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Post(':suppressionId/remove')
    remove(
        @Param('suppressionId', ParseUUIDPipe) suppressionId: string,
        @Body() body: RemoveSuppressionDto,
    ): Promise<void> {
        return this.suppressions.remove(suppressionId, body.note);
    }
}

/**
 * The unsubscribe link's public routes (P3-1, RFC 8058). No session: the token is the proof, and the
 * workspace comes from it. A GET never unsubscribes — link scanners and mail clients prefetch GETs —
 * it leads to the confirmation page; the POST (a mail client's one-click, or the page's button) does.
 * Rate-limited per client.
 */
@ApiTags('suppression')
@Controller('unsubscribe')
@Public()
@UseGuards(UnsubscribeRateGuard)
export class UnsubscribeController {
    constructor(private readonly unsubscribe: UnsubscribeService) {}

    /** One-click: the body (`List-Unsubscribe=One-Click`, urlencoded or multipart) is not needed and not read. */
    @HttpCode(200)
    @Post(':token')
    @Returns(unsubscribeStatus)
    confirm(@Param('token') token: string): Promise<UnsubscribeStatusView> {
        return this.unsubscribe.unsubscribe(token);
    }

    @Get(':token/status')
    @Returns(unsubscribeStatus)
    status(@Param('token') token: string): Promise<UnsubscribeStatusView> {
        return this.unsubscribe.status(token);
    }

    /** Opening the header's URL in a browser: `303` to the confirmation page, nothing changed. */
    @Get(':token')
    @Redirects(303)
    async page(@Param('token') token: string, @Res() res: Response): Promise<void> {
        res.redirect(303, await this.unsubscribe.page(token));
    }
}
