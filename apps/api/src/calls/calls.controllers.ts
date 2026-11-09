import {
    Body,
    Delete,
    Get,
    Headers,
    HttpCode,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
    Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { CallView, QuoSettingsView } from '@bylinecrm/shared';
import type { Request } from 'express';
import { Requires, SignedInbound, TenantController } from '../auth/decorators';
import type { RequestWithRawBody } from '../infra/errors/body-parsing';
import { Returns } from '../openapi/responses';
import { QUO_HOOK_PATH } from './calls.constants';
import { CallsService } from './calls.service';
import { ListCallsQueryDto, LogCallDto, PatchCallDto, PutQuoSettingsDto } from './dto';
import { QuoHookService, type QuoHookResult } from './quo-hook.service';
import { QuoSettingsService } from './quo-settings.service';
import { QUO_ID_HEADER, QUO_SIGNATURE_HEADER, QUO_TIMESTAMP_HEADER } from './quo-signature';
import { callView, quoHookResult, quoSettingsView } from './responses';

/** The workspace's Quo link (CALL-1): an admin's. */
@ApiTags('calls')
@TenantController('integrations/quo')
export class QuoSettingsController {
    constructor(private readonly settings: QuoSettingsService) {}

    @Requires('workspace:admin')
    @Get()
    @Returns(quoSettingsView)
    get(): Promise<QuoSettingsView> {
        return this.settings.get();
    }

    @Requires('workspace:admin')
    @Put()
    @Returns(quoSettingsView)
    put(@Body() body: PutQuoSettingsDto): Promise<QuoSettingsView> {
        return this.settings.put(body);
    }

    @Requires('workspace:admin')
    @Post('rematch')
    @HttpCode(200)
    @Returns(quoSettingsView)
    rematch(): Promise<QuoSettingsView> {
        return this.settings.rematch();
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete()
    remove(): Promise<void> {
        return this.settings.remove();
    }
}

/** Where Quo posts call events (CALL-1): no session; the path names the workspace, the signature proves the sender. */
@ApiTags('calls')
@TenantController(QUO_HOOK_PATH)
export class QuoHookController {
    constructor(private readonly hook: QuoHookService) {}

    @SignedInbound(
        'Quo’s webhook: Standard Webhooks HMAC (webhook-id, webhook-timestamp, webhook-signature) with the webhook’s key',
    )
    @HttpCode(200)
    @Post()
    @Returns(quoHookResult)
    async receive(
        @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
        @Headers(QUO_ID_HEADER) id: string | undefined,
        @Headers(QUO_TIMESTAMP_HEADER) timestamp: string | undefined,
        @Headers(QUO_SIGNATURE_HEADER) signature: string | undefined,
        @Req() req: Request & RequestWithRawBody,
        @Body() body: unknown,
    ): Promise<{ result: QuoHookResult }> {
        return {
            result: await this.hook.receive(workspaceId, { id, timestamp, signature }, req.rawBody, body, req.ip ?? ''),
        };
    }
}

/** Calls on a person (CALL-1): logged from the Call panel, read on the record. */
@ApiTags('calls')
@TenantController('calls')
export class CallsController {
    constructor(private readonly calls: CallsService) {}

    @Requires('record:read')
    @Get()
    @Returns([callView])
    list(@Query() query: ListCallsQueryDto): Promise<CallView[]> {
        return this.calls.listForPerson(query.personId);
    }

    @Requires('record:read')
    @Get(':id')
    @Returns(callView)
    get(@Param('id', ParseUUIDPipe) id: string): Promise<CallView> {
        return this.calls.get(id);
    }

    @Requires('note:write')
    @Post()
    @HttpCode(201)
    @Returns(callView)
    log(@Body() body: LogCallDto): Promise<CallView> {
        return this.calls.log({
            personId: body.personId,
            direction: body.direction,
            disposition: body.disposition,
            startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
            durationSec: body.durationSec,
            note: body.note,
        });
    }

    @Requires('note:write')
    @Patch(':id')
    @Returns(callView)
    patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: PatchCallDto): Promise<CallView> {
        return this.calls.patch(id, body);
    }
}
