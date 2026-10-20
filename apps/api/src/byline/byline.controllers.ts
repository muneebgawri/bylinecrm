import { Body, Delete, Get, Headers, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BYLINE_SIGNATURE_HEADER } from '@byline/contract';
import type { Request } from 'express';
import { Requires, SignedInbound, TenantController } from '../auth/decorators';
import type { RequestWithRawBody } from '../infra/errors/body-parsing';
import { Returns } from '../openapi/responses';
import { BylineInboundService } from './byline-inbound.service';
import { BylineSettingsService } from './byline-settings.service';
import { BYLINE_INBOUND_PATH } from './byline.constants';
import { PutBylineSettingsDto } from './dto';
import { bylineLeadResult, bylineSettingsView, type BylineLeadResult, type BylineSettingsView } from './responses';

/** The workspace's BylineAI link (BYL-1): an admin's. */
@ApiTags('byline')
@TenantController('integrations/byline')
export class BylineSettingsController {
    constructor(private readonly settings: BylineSettingsService) {}

    @Requires('workspace:admin')
    @Get()
    @Returns(bylineSettingsView)
    get(): Promise<BylineSettingsView> {
        return this.settings.get();
    }

    @Requires('workspace:admin')
    @Put()
    @Returns(bylineSettingsView)
    put(@Body() body: PutBylineSettingsDto): Promise<BylineSettingsView> {
        return this.settings.put(body);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete()
    remove(): Promise<void> {
        return this.settings.remove();
    }
}

/** Where BylineAI posts leads (BYL-1): no session; the path names the workspace, the signature proves the sender. */
@ApiTags('byline')
@TenantController(BYLINE_INBOUND_PATH)
export class BylineInboundController {
    constructor(private readonly inbound: BylineInboundService) {}

    @SignedInbound('BylineAI’s WEBHOOK connector: HMAC over the raw body with the workspace’s secret')
    @HttpCode(200)
    @Post()
    @Returns(bylineLeadResult)
    receive(
        @Param('workspaceId') workspaceId: string,
        @Headers(BYLINE_SIGNATURE_HEADER) signature: string | undefined,
        @Req() req: Request & RequestWithRawBody,
        @Body() body: unknown,
    ): Promise<BylineLeadResult> {
        return this.inbound.receive(workspaceId, req.rawBody, signature, body, req.ip ?? '');
    }
}
