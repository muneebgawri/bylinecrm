import { Body, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { TransferPreviewView, TransferView } from '@bylinecrm/shared';
import { AnyMember, Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { DecideTransferDto, ListTransfersQueryDto, PreviewTransferQueryDto, ProposeTransferDto } from './dto';
import { transferPreviewView, transferView } from './responses';
import { TransfersService } from './transfers.service';

/** Ownership transfers (OWN-1, FR-CRMS-17): propose, accept, decline, cancel; a record's history; the inbox. */
@ApiTags('transfers')
@TenantController('transfers')
export class TransfersController {
    constructor(private readonly transfers: TransfersService) {}

    /** A member sees the transfers they are party to; a holder of `record:transfer` sees every one. */
    @AnyMember('a member reads the transfers they are party to')
    @Get()
    @Returns([transferView])
    list(@Query() query: ListTransfersQueryDto): Promise<TransferView[]> {
        return this.transfers.list(query);
    }

    /**
     * OWN-1b: what a manager's move would take, and from whom — every person and open deal at the record's
     * company, whoever holds them. Shown as a confirmation before `POST /transfers`.
     */
    @Requires('record:transfer')
    @Get('preview')
    @Returns(transferPreviewView)
    preview(@Query() query: PreviewTransferQueryDto): Promise<TransferPreviewView> {
        return this.transfers.preview(query);
    }

    /**
     * The owner offers the record; with `record:transfer` it moves at once (`forced`) — a company, or a person at
     * one, with the whole company (OWN-1b): every person at it and their open deals, whoever holds them.
     */
    @Requires('record:write')
    @Post()
    @Returns(transferView)
    propose(@Body() body: ProposeTransferDto): Promise<TransferView> {
        return this.transfers.propose(body);
    }

    @AnyMember('the member a transfer is offered to accepts it')
    @Post(':transferId/accept')
    @Returns(transferView)
    accept(@Param('transferId', ParseUUIDPipe) id: string): Promise<TransferView> {
        return this.transfers.accept(id);
    }

    @AnyMember('the member a transfer is offered to declines it')
    @Post(':transferId/decline')
    @Returns(transferView)
    decline(@Param('transferId', ParseUUIDPipe) id: string, @Body() body: DecideTransferDto): Promise<TransferView> {
        return this.transfers.decline(id, body.note);
    }

    @AnyMember('who proposed a transfer, or a manager, cancels it')
    @Post(':transferId/cancel')
    @Returns(transferView)
    cancel(@Param('transferId', ParseUUIDPipe) id: string, @Body() body: DecideTransferDto): Promise<TransferView> {
        return this.transfers.cancel(id, body.note);
    }
}
