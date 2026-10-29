import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { DealInvoiceView } from '@bylinecrm/shared';
import { Public, Requires, TenantController } from '../auth/decorators';
import type { RequestWithRawBody } from '../infra/errors/body-parsing';
import { Returns } from '../openapi/responses';
import { DealWonPushService } from './deal-won-push.service';
import {
    CreateInvoiceDto,
    ChoosePaymentDealDto,
    PutDealWonPushDto,
    PutPaymentModeDto,
    PutNewswireosSettingsDto,
    PutOwnershipPushDto,
    RejectInvoiceDto,
    VerifyInvoiceDto,
} from './dto';
import { NEWSWIREOS_HOOK_PATH, NEWSWIREOS_SIGNATURE_HEADER, NEWSWIREOS_WEBHOOK_ID_HEADER } from './invoices.constants';
import { InvoicesService } from './invoices.service';
import { NewswireosHookService } from './newswireos-hook.service';
import { NewswireosPaymentsService } from './newswireos-payments.service';
import { NewswireosSettingsService } from './newswireos-settings.service';
import { OwnershipPushService } from './ownership-push.service';
import {
    dealInvoiceView,
    dealWonDeliveryView,
    dealWonPushPreview,
    newswireosHookResult,
    newswireosInvoiceLinkView,
    newswireosPaymentReviewView,
    newswireosPaymentView,
    newswireosSettingsView,
    ownershipDeliveryView,
    ownershipPushPreview,
    type DealWonDeliveryView,
    type DealWonPushPreview,
    type NewswireosHookResult,
    type NewswireosInvoiceLinkView,
    type NewswireosPaymentReviewView,
    type NewswireosPaymentView,
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
    /** INV-2: where this deal's invoice is raised in NewswireOS, so the paid invoice comes back naming the deal. */
    @Requires('deal:read')
    @Get('newswireos-link')
    @Returns(newswireosInvoiceLinkView)
    newswireosLink(@Param('opportunityId', ParseUUIDPipe) opportunityId: string): Promise<NewswireosInvoiceLinkView> {
        return this.invoices.newswireosLink(opportunityId) as Promise<NewswireosInvoiceLinkView>;
    }

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
        private readonly dealWon: DealWonPushService,
        private readonly paymentsService: NewswireosPaymentsService,
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

    /** INV-2: what a paid invoice NewswireOS reports does — `off`, `shadow` or `on`. `404` without a link. */
    @Requires('workspace:admin')
    @Put('payment-mode')
    @Returns(newswireosSettingsView)
    putPaymentMode(@Body() body: PutPaymentModeDto): Promise<NewswireosSettingsView> {
        return this.settings.setPaymentMode(body.mode);
    }

    /** INV-2: the latest paid invoices NewswireOS reported, beside what Account Managers entered (shadow's check). */
    @Requires('workspace:admin')
    @Get('payments')
    @Returns([newswireosPaymentReviewView])
    payments(): Promise<NewswireosPaymentReviewView[]> {
        return this.paymentsService.list();
    }

    /** PNW-766: pushes won deals to NewswireOS, which makes their contacts clients, or stops. `404` without a link. */
    @Requires('workspace:admin')
    @Put('deal-won-push')
    @Returns(newswireosSettingsView)
    async putDealWonPush(@Body() body: PutDealWonPushDto): Promise<NewswireosSettingsView> {
        await this.dealWon.setEnabled(body.enabled);
        return this.settings.get();
    }

    /** PNW-766: the latest won deals pushed to NewswireOS, newest first. */
    @Requires('workspace:admin')
    @Get('deal-won-push/deliveries')
    @Returns([dealWonDeliveryView])
    dealWonDeliveries(): Promise<DealWonDeliveryView[]> {
        return this.dealWon.deliveries();
    }

    /** PNW-766: a dry run. Nothing is sent; the body a push would send for the latest won deal that qualifies. */
    @Requires('workspace:admin')
    @HttpCode(200)
    @Post('deal-won-push/test')
    @Returns(dealWonPushPreview)
    testDealWonPush(): Promise<DealWonPushPreview> {
        return this.dealWon.preview();
    }
}

/**
 * Where NewswireOS posts refunds and chargebacks, and (PNW-766) its client activity for the timeline: public; the
 * token names the workspace, the signature proves it.
 */
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
        @Headers(NEWSWIREOS_WEBHOOK_ID_HEADER) webhookId: string | undefined,
        @Req() req: Request & RequestWithRawBody,
        @Body() body: unknown,
    ): Promise<NewswireosHookResult> {
        return this.hook.receive(token, req.rawBody, signature, body, req.ip ?? '', webhookId);
    }
}

/** INV-2: a paid invoice NewswireOS reported, for the page its notification opens, and choosing its deal. */
@ApiTags('invoices')
@TenantController('newswireos-payments')
export class NewswireosPaymentsController {
    constructor(private readonly payments: NewswireosPaymentsService) {}

    @Requires('deal:read')
    @Get(':paymentId')
    @Returns(newswireosPaymentView)
    get(@Param('paymentId', ParseUUIDPipe) paymentId: string): Promise<NewswireosPaymentView> {
        return this.payments.get(paymentId);
    }

    /** Puts the payment on the deal chosen: the deal's owner, or whoever verifies invoices. */
    @Requires('deal:edit')
    @HttpCode(200)
    @Post(':paymentId/choose')
    @Returns(newswireosPaymentView)
    choose(
        @Param('paymentId', ParseUUIDPipe) paymentId: string,
        @Body() body: ChoosePaymentDealDto,
    ): Promise<NewswireosPaymentView> {
        return this.payments.choose(paymentId, body.opportunityId);
    }
}
