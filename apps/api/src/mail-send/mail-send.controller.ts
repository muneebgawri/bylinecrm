import { Body, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { parseTarget } from '../records/targets';
import {
    CcSuggestionsQueryDto,
    ListRecordSendsQueryDto,
    ListScheduledQueryDto,
    PreviewMailDto,
    RescheduleMailDto,
    SendMailDto,
} from './dto';
import type { ComposedEmail } from '../templates/render/compose';
import { renderedEmail } from '../templates/responses';
import { CcSuggestionsService } from './cc-suggestions.service';
import { MailSendService } from './mail-send.service';
import {
    mailCcSuggestions,
    mailOutboundView,
    mailRecordSendsPage,
    mailScheduledPage,
    mailSendAccepted,
    type MailCcSuggestions,
    type MailOutboundView,
    type MailRecordSendsPage,
    type MailScheduledPage,
    type MailSendAccepted,
} from './responses';

/** Sending mail (P2-3, P2-5): from the caller's own connected personal mailbox, now or at a set time. */
@ApiTags('mail')
@TenantController('mail')
export class MailSendController {
    constructor(
        private readonly send: MailSendService,
        private readonly ccSuggestions: CcSuggestionsService,
    ) {}

    /**
     * Who else to Cc: the To recipients' colleagues — the other live people at their companies, within the caller's
     * record scope, with an address, whom a send would accept (the suppression list and the recipient guard, asked
     * without an audit). Grouped by company in the To line's order, most recently contacted first; empty for a
     * recipient with no company. An offer the composer shows as chips: nobody is added by being listed.
     */
    @Requires('record:read')
    @Get('cc-suggestions')
    @Returns(mailCcSuggestions)
    suggestCc(@Query() query: CcSuggestionsQueryDto): Promise<MailCcSuggestions> {
        return this.ccSuggestions.suggest(query.personIds);
    }

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

    /**
     * The message rendered as it would be sent, signature included, and never sent: the composer's preview. `200`,
     * with any variable that has no value named in `missing`.
     */
    @Requires('email:send')
    @HttpCode(200)
    @Post('preview')
    @Returns(renderedEmail)
    preview(@Body() body: PreviewMailDto): Promise<ComposedEmail> {
        return this.send.preview(body);
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
