import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiExtraModels, ApiTags } from '@nestjs/swagger';
import { Requires } from '../auth/decorators';
import { WorkspaceContext } from '../infra/workspace-context';
import type { Page } from '../records/list-query';
import { CreateWebhookDto, ListDeliveriesQueryDto, UpdateWebhookDto, WebhookEnvelopeDto } from './dto';
import {
    WebhooksService,
    type WebhookDeliveryView,
    type WebhookEndpointView,
    type WebhookEventView,
} from './webhooks.service';

/**
 * Outbound webhooks: what the workspace's administrators register, test, rotate and inspect.
 * Every route is `workspace:admin` — an endpoint URL is a place the API will send the workspace's
 * data, which is an administrator's decision.
 */
@ApiTags('webhooks')
@ApiExtraModels(WebhookEnvelopeDto)
@Controller('w/:workspaceId/webhooks')
export class WebhooksController {
    constructor(
        private readonly webhooks: WebhooksService,
        private readonly context: WorkspaceContext,
    ) {}

    /** The catalogue an endpoint may subscribe to; the delivery body is `WebhookEnvelopeDto`. */
    @Requires('workspace:admin')
    @Get('events')
    events(): WebhookEventView[] {
        return this.webhooks.events();
    }

    @Requires('workspace:admin')
    @Get()
    list(): Promise<WebhookEndpointView[]> {
        return this.webhooks.list();
    }

    /** The response carries the signing secret once; it is not shown again. */
    @Requires('workspace:admin')
    @Post()
    create(@Body() body: CreateWebhookDto): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
        const memberId = this.context.get()?.memberId;
        if (!memberId) throw new Error('webhook endpoints are created by a member, not by an API key');
        return this.webhooks.create({ ...body, createdById: memberId });
    }

    @Requires('workspace:admin')
    @Get(':endpointId')
    get(@Param('endpointId', ParseUUIDPipe) endpointId: string): Promise<WebhookEndpointView> {
        return this.webhooks.get(endpointId);
    }

    @Requires('workspace:admin')
    @Patch(':endpointId')
    update(
        @Param('endpointId', ParseUUIDPipe) endpointId: string,
        @Body() body: UpdateWebhookDto,
    ): Promise<WebhookEndpointView> {
        return this.webhooks.update(endpointId, body);
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete(':endpointId')
    remove(@Param('endpointId', ParseUUIDPipe) endpointId: string): Promise<void> {
        return this.webhooks.remove(endpointId);
    }

    /** A new secret, shown once; the previous one keeps signing for the grace window. */
    @Requires('workspace:admin')
    @Post(':endpointId/rotate')
    rotate(
        @Param('endpointId', ParseUUIDPipe) endpointId: string,
    ): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
        return this.webhooks.rotate(endpointId);
    }

    /** Sends a `ping` now and answers with what the receiver said. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post(':endpointId/test')
    test(
        @Param('endpointId', ParseUUIDPipe) endpointId: string,
    ): Promise<{ delivery: WebhookDeliveryView; statusCode: number | null; ok: boolean }> {
        return this.webhooks.test(endpointId);
    }

    @Requires('workspace:admin')
    @Get(':endpointId/deliveries')
    deliveries(
        @Param('endpointId', ParseUUIDPipe) endpointId: string,
        @Query() query: ListDeliveriesQueryDto,
    ): Promise<Page<WebhookDeliveryView>> {
        return this.webhooks.deliveries(endpointId, { status: query.status, cursor: query.cursor, limit: query.limit });
    }

    /** Queues the same event again as a new delivery. */
    @Requires('workspace:admin')
    @HttpCode(201)
    @Post(':endpointId/deliveries/:deliveryId/redeliver')
    redeliver(
        @Param('endpointId', ParseUUIDPipe) endpointId: string,
        @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    ): Promise<WebhookDeliveryView> {
        return this.webhooks.redeliver(endpointId, deliveryId);
    }
}
