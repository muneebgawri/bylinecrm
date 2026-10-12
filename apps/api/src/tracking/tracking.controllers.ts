import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TRACKING_CLICK_PATH, TRACKING_OPEN_PATH, type TrackingSettingsView } from '@bylinecrm/shared';
import type { Response } from 'express';
import { Public, Requires, TenantController } from '../auth/decorators';
import { Redirects, Returns, ReturnsFile } from '../openapi/responses';
import { PutTrackingDomainDto } from './dto';
import { trackingSettingsView } from './responses';
import { TrackingDomainService } from './tracking-domain.service';
import { TrackingRateGuard } from './tracking-rate.guard';
import { TRACKING_PIXEL_GIF } from './tracking.constants';
import { TrackingService } from './tracking.service';

/**
 * The workspace's short-link domain (P3-4, FR-CRMS-8): read with outreach rights (the sequence pages
 * say whether links are tracked), set, checked and removed by an admin.
 */
@ApiTags('tracking')
@TenantController('tracking')
export class TrackingDomainController {
    constructor(private readonly domains: TrackingDomainService) {}

    @Requires('outreach:write')
    @Get('domain')
    @Returns(trackingSettingsView)
    get(): Promise<TrackingSettingsView> {
        return this.domains.get();
    }

    @Requires('workspace:admin')
    @Put('domain')
    @Returns(trackingSettingsView)
    put(@Body() body: PutTrackingDomainDto): Promise<TrackingSettingsView> {
        return this.domains.set(body.domain);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete('domain')
    remove(): Promise<void> {
        return this.domains.remove();
    }

    /** Looks the CNAME up now, through DNS, and records the outcome. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('domain/check')
    @Returns(trackingSettingsView)
    check(): Promise<TrackingSettingsView> {
        return this.domains.check();
    }
}

/**
 * The public routes a short-link domain serves (P3-4). No session, no workspace in the URL: the
 * token is the proof and names its workspace. Outside the API prefix, so `https://go.example.com/r/…`
 * is the whole link. Rate-limited per client. Never cached: every fetch is a hit.
 */
@ApiTags('tracking')
@Controller()
@Public()
@UseGuards(TrackingRateGuard)
export class TrackingPublicController {
    constructor(private readonly tracking: TrackingService) {}

    /** A click: `302` to the link's original URL; `404` for a token that is not a link's. */
    @Get(`${TRACKING_CLICK_PATH}/:token`)
    @Redirects(302)
    async click(
        @Param('token') token: string,
        @Headers('user-agent') userAgent: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        const url = await this.tracking.hit('click', token, { userAgent, at: new Date() });
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.redirect(302, url ?? '/');
    }

    /** The open pixel: a 1×1 GIF, recorded as an indicative open; `404` for a token that is not a pixel's. */
    @Get(`${TRACKING_OPEN_PATH}/:token`)
    @ReturnsFile('image/gif')
    async open(
        @Param('token') token: string,
        @Headers('user-agent') userAgent: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        await this.tracking.hit('open', token, { userAgent, at: new Date() });
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.type('image/gif').send(TRACKING_PIXEL_GIF);
    }
}
