import { Body, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { SendMailDto } from './dto';
import { MailSendService } from './mail-send.service';
import { mailOutboundView, mailSendQueued, type MailOutboundView, type MailSendQueued } from './responses';

/** Sending mail (P2-3): from the caller's own connected personal mailbox, through a queued job. */
@ApiTags('mail')
@TenantController('mail')
export class MailSendController {
    constructor(private readonly send: MailSendService) {}

    /**
     * Builds the message, checks it (an empty variable, an outreach template, a pool or someone
     * else's mailbox are refused) and queues it. `202`: the send happens in a job; read where it
     * stands at `GET /mail/messages/:messageId`.
     */
    @Requires('email:send')
    @HttpCode(202)
    @Post('send')
    @Returns(mailSendQueued)
    compose(@Body() body: SendMailDto): Promise<MailSendQueued> {
        return this.send.compose(body);
    }

    /** Where a send stands: its sender's, or an admin's to read. */
    @Requires('email:send')
    @Get('messages/:messageId')
    @Returns(mailOutboundView)
    status(@Param('messageId', ParseUUIDPipe) messageId: string): Promise<MailOutboundView> {
        return this.send.status(messageId);
    }
}
