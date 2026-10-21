import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { DealInvoiceView } from '@bylinecrm/shared';
import { Public, Requires, TenantController } from '../auth/decorators';
import type { RequestWithRawBody } from '../infra/errors/body-parsing';
import { Returns } from '../openapi/responses';
import {
    CreateInvoiceDto,
    PutNewswireosSettingsDto,
    PutOwnershipPushDto,
    RejectInvoiceDto,
    VerifyInvoiceDto,
} from './dto';
import { NEWSWIREOS_HOOK_PATH, NEWSWIREOS_SIGNATURE_HEADER } from './invoices.constants';
import { InvoicesService } from './invoices.service';
import { NewswireosHookService } from './newswireos-hook.service';
import { NewswireosSettingsService } from './newswireos-settings.service';
import { OwnershipPushService } from './ownership-push.service';
import {
    dealInvoiceView,
    newswireosHookResult,
    newswireosSettingsView,
    ownershipDeliveryView,
    ownershipPushPreview,
    type NewswireosHookResult,
    type NewswireosSettingsView,
    type OwnershipDeliveryView,
    type OwnershipPushPreview,
} from './responses';

/** Invoices on a deal (INV-1, FR-CRMS-19). */
@ApiTags('invoices')
@TenantController('opportunities/:opportunityId/invoices')
export class InvoicesController {
    constructor(private readonly invoices: InvoicesService) {}

    @Requires('deal:read')
    @Get()
    @Returns([dealInvoiceView])
    list(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<DealInvoiceView[]> {
        return this.invoices.list(opportunityId);
    }

    /** Enters a payment's reference; NewswireOS is asked in the background. `409` if the payment is on a deal. */
    @Requires('deal:edit')
    @Post()
    @Returns(dealInvoiceView)
    create(
        @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
        @Body() body: CreateInvoiceDto,
    ): Promise<DealInvoiceView> {
        return this.invoices.create(opportunityId, body);
    }

    /** Verifies an invoice waiting for finance by hand. */
    @Requires('invoice:verify')
    @HttpCode(200)
    @Post(':invoiceId/verify')
    @Returns(dealInvoiceView)
    verify(
        @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
        @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
        @Body() body: VerifyInvoiceDto,
    ): Promise<DealInvoiceView> {
        return this.invoices.verifyByHand(opportunityId, invoiceId, body.note);
    }

    /** Refuses an invoice waiting for finance by hand, with why. */
    @Requires('invoice:verify')
    @HttpCode(200)
    @Post(':invoiceId/reject')
    @Returns(dealInvoiceView)
    reject(
        @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
        @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
        @Body() body: RejectInvoiceDto,
    ): Promise<DealInvoiceView> {
        return this.invoices.rejectByHand(opportunityId, invoiceId, body.reason);
    }

    /** Asks NewswireOS again about an invoice waiting for finance. */
    @Requires('deal:edit')
    @HttpCode(200)
    @Post(':invoiceId/recheck')
    @Returns(dealInvoiceView)
    recheck(
        @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
        @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    ): Promise<DealInvoiceView> {
        return this.invoices.recheck(opportunityId, invoiceId);
    }
}

/** The workspace's NewswireOS link (INV-1): an admin's. */
@ApiTags('invoices')
@TenantController('integrations/newswireos')
export class NewswireosSettingsController {
    constructor(
        private readonly settings: NewswireosSettingsService,
        private readonly ownership: OwnershipPushService,
    ) {}

    @Requires('workspace:admin')
    @Get()
    @Returns(newswireosSettingsView)
    get(): Promise<NewswireosSettingsView> {
        return this.settings.get();
    }

    @Requires('workspace:admin')
    @Put()
    @Returns(newswireosSettingsView)
    put(@Body() body: PutNewswireosSettingsDto): Promise<NewswireosSettingsView> {
        return this.settings.put(body);
    }

    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('rotate')
    @Returns(newswireosSettingsView)
    rotate(): Promise<NewswireosSettingsView> {
        return this.settings.rotate();
    }

    @Requires('workspace:admin')
    @HttpCode(204)
    @Delete()
    remove(): Promise<void> {
        return this.settings.remove();
    }

    /** PNW-765: pushes completed ownership transfers to NewswireOS, or stops. `404` without a link. */
    @Requires('workspace:admin')
    @Put('ownership-push')
    @Returns(newswireosSettingsView)
    async putOwnershipPush(@Body() body: PutOwnershipPushDto): Promise<NewswireosSettingsView> {
        await this.ownership.setEnabled(body.enabled);
        return this.settings.get();
    }

    /** PNW-765: the latest ownership changes pushed to NewswireOS, newest first. */
    @Requires('workspace:admin')
    @Get('ownership-push/deliveries')
    @Returns([ownershipDeliveryView])
    ownershipDeliveries(): Promise<OwnershipDeliveryView[]> {
        return this.ownership.deliveries();
    }

    /** PNW-765: a dry run. Nothing is sent (NewswireOS reads no `test` flag); the body a push would send. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('ownership-push/test')
    @Returns(ownershipPushPreview)
    testOwnershipPush(): Promise<OwnershipPushPreview> {
        return this.ownership.preview();
    }
}

/** Where NewswireOS posts refunds and chargebacks: public; the token names the workspace, the signature proves it. */
@ApiTags('invoices')
@Controller(NEWSWIREOS_HOOK_PATH.replace(/^\/api\//, ''))
@Public()
export class NewswireosHookController {
    constructor(private readonly hook: NewswireosHookService) {}

    @HttpCode(200)
    @Post(':token')
    @Returns(newswireosHookResult)
    receive(
        @Param('token') token: string,
        @Headers(NEWSWIREOS_SIGNATURE_HEADER) signature: string | undefined,
        @Req() req: Request & RequestWithRawBody,
        @Body() body: unknown,
    ): Promise<NewswireosHookResult> {
        return this.hook.receive(token, req.rawBody, signature, body, req.ip ?? '');
    }
}
