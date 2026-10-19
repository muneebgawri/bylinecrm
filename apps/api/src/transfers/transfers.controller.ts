import { Body, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { TransferView } from '@bylinecrm/shared';
import { AnyMember, Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { DecideTransferDto, ListTransfersQueryDto, ProposeTransferDto } from './dto';
import { transferView } from './responses';
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

    /** The owner offers the record; with `record:transfer` it moves at once (`forced`). */
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
