import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, Requires, TenantController } from '../../auth/decorators';
import type { RequestWithRawBody } from '../../infra/errors/body-parsing';
import { Returns } from '../../openapi/responses';
import { PutSlotlineSettingsDto } from './dto';
import {
    slotlineHookResult,
    slotlineSettingsView,
    type SlotlineHookResult,
    type SlotlineSettingsView,
} from './responses';
import { SlotlineHookService } from './slotline-hook.service';
import { SlotlineSettingsService } from './slotline-settings.service';
import { SLOTLINE_HOOK_PATH, SLOTLINE_SIGNATURE_HEADER } from './slotline.constants';

/** The workspace's Slotline booking site (CAL-2): an admin's. */
@ApiTags('calendar')
@TenantController('integrations/slotline')
export class SlotlineSettingsController {
    constructor(private readonly settings: SlotlineSettingsService) {}

    @Requires('workspace:admin')
    @Get()
    @Returns(slotlineSettingsView)
    get(): Promise<SlotlineSettingsView> {
        return this.settings.get();
    }

    /** Sets the booking site and the webhook's secret (needed the first time); the hook URL is made once. */
    @Requires('workspace:admin')
    @Put()
    @Returns(slotlineSettingsView)
    put(@Body() body: PutSlotlineSettingsDto): Promise<SlotlineSettingsView> {
        return this.settings.put(body);
    }

    /** A new hook URL; the old one stops working at once. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('rotate')
    @Returns(slotlineSettingsView)
    rotate(): Promise<SlotlineSettingsView> {
        return this.settings.rotate();
    }

    /** Stops taking bookings from Slotline; meetings already stored stay. */
    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete()
    remove(): Promise<void> {
        return this.settings.remove();
    }
}

/**
 * Where Slotline posts its bookings: public, the token in the path names the workspace, the signature proves it.
 * Refused deliveries are rate-limited per client address in the service; accepted ones never are.
 */
@ApiTags('calendar')
@Controller(SLOTLINE_HOOK_PATH.replace(/^\/api\//, ''))
@Public()
export class SlotlineHookController {
    constructor(private readonly hook: SlotlineHookService) {}

    /** `401` for a wrong signature, `404` for a token that is no workspace's; otherwise what was done with it. */
    @HttpCode(200)
    @Post(':token')
    @Returns(slotlineHookResult)
    receive(
        @Param('token') token: string,
        @Headers(SLOTLINE_SIGNATURE_HEADER) signature: string | undefined,
        @Req() req: Request & RequestWithRawBody,
        @Body() body: unknown,
    ): Promise<SlotlineHookResult> {
        return this.hook.receive(token, req.rawBody, signature, body, req.ip ?? '');
    }
}
