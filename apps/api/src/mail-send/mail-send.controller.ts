import { Body, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { parseTarget } from '../records/targets';
import { ListRecordSendsQueryDto, ListScheduledQueryDto, RescheduleMailDto, SendMailDto } from './dto';
import { MailSendService } from './mail-send.service';
import {
    mailOutboundView,
    mailRecordSendsPage,
    mailScheduledPage,
    mailSendAccepted,
    type MailOutboundView,
    type MailRecordSendsPage,
    type MailScheduledPage,
    type MailSendAccepted,
} from './responses';

/** Sending mail (P2-3, P2-5): from the caller's own connected personal mailbox, now or at a set time. */
@ApiTags('mail')
@TenantController('mail')
export class MailSendController {
    constructor(private readonly send: MailSendService) {}

    /**
     * Builds the message, checks it (an empty variable, an outreach template, a pool or someone
     * else's mailbox are refused) and queues it — or, with `sendAt`, schedules it: the same checks
     * run now and again at `sendAt`, where any that fails then fails the send. `202`: the send
     * happens in a job; read where it stands at `GET /mail/messages/:messageId`.
     */
    @Requires('email:send')
    @HttpCode(202)
    @Post('send')
    @Returns(mailSendAccepted)
    compose(@Body() body: SendMailDto): Promise<MailSendAccepted> {
        return this.send.compose(body);
    }

    /** The caller's scheduled sends (an admin's: everyone's), soonest first. */
    @Requires('email:send')
    @Get('scheduled')
    @Returns(mailScheduledPage)
    scheduled(@Query() query: ListScheduledQueryDto): Promise<MailScheduledPage> {
        return this.send.scheduled(query.limit, query.cursor);
    }

    /**
     * The sends about one record (#104) — a person's, a deal's, or a company's people's — in the
     * statuses asked for, newest first: what a record page shows besides its stored mail (a failed
     * send with its reason, a scheduled one). Only on a record the caller can read (`404`
     * otherwise), and only the sends the caller may see: their own, or every one for an admin.
     */
    @Requires('email:send')
    @Get('messages')
    @Returns(mailRecordSendsPage)
    recordSends(@Query() query: ListRecordSendsQueryDto): Promise<MailRecordSendsPage> {
        return this.send.recordSends(parseTarget(query.target), query.status, query.limit, query.cursor);
    }

    /** Where a send stands: its sender's, or an admin's to read. */
    @Requires('email:send')
    @Get('messages/:messageId')
    @Returns(mailOutboundView)
    status(@Param('messageId', ParseUUIDPipe) messageId: string): Promise<MailOutboundView> {
        return this.send.status(messageId);
    }

    /** Moves a scheduled send to another time — its sender or an admin, while it is scheduled (`409` after). */
    @Requires('email:send')
    @Patch('messages/:messageId')
    @Returns(mailOutboundView)
    reschedule(
        @Param('messageId', ParseUUIDPipe) messageId: string,
        @Body() body: RescheduleMailDto,
    ): Promise<MailOutboundView> {
        return this.send.reschedule(messageId, body);
    }

    /**
     * Sends a failed send again (#134) — its sender or an admin: rebuilt and checked as things stand
     * now, through the same path as a scheduled send at its time. Idempotent while the retry is
     * under way; `409` for a send that is not failed or whose refusal would repeat.
     */
    @Requires('email:send')
    @HttpCode(200)
    @Post('messages/:messageId/retry')
    @Returns(mailOutboundView)
    retry(@Param('messageId', ParseUUIDPipe) messageId: string): Promise<MailOutboundView> {
        return this.send.retry(messageId);
    }

    /** Calls a scheduled send off — its sender or an admin; idempotent; `409` once it has started. */
    @Requires('email:send')
    @HttpCode(200)
    @Post('messages/:messageId/cancel')
    @Returns(mailOutboundView)
    cancel(@Param('messageId', ParseUUIDPipe) messageId: string): Promise<MailOutboundView> {
        return this.send.cancel(messageId);
    }
}
