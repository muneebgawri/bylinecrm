import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { parseTarget } from '../records/targets';
import { CreateMailDraftDto, ListMailDraftsQueryDto, SaveMailDraftDto } from './dto';
import { MailDraftsService } from './mail-drafts.service';
import { mailDraftPage, mailDraftView, type MailDraftPage, type MailDraftView } from './responses';

/**
 * Composer drafts: the caller's own unsent messages on a record, saved as they write. Private to their author —
 * another member's draft reads as missing. `POST /mail/send` with `draftId` deletes the draft with the send.
 */
@ApiTags('mail')
@TenantController('mail/drafts')
export class MailDraftsController {
    constructor(private readonly drafts: MailDraftsService) {}

    /** The caller's drafts about one record (a company's: its people's), last edited first. */
    @Requires('email:send')
    @Get()
    @Returns(mailDraftPage)
    list(@Query() query: ListMailDraftsQueryDto): Promise<MailDraftPage> {
        return this.drafts.list(parseTarget(query.target), query.limit, query.cursor);
    }

    /** One of the caller's drafts. */
    @Requires('email:send')
    @Get(':draftId')
    @Returns(mailDraftView)
    get(@Param('draftId', ParseUUIDPipe) draftId: string): Promise<MailDraftView> {
        return this.drafts.get(draftId);
    }

    /**
     * A new draft in one composer: a person's, or a person's on a deal. One per composer — a second is `409`
     * naming the one there is (`details.draftId`, `details.version`).
     */
    @Requires('email:send')
    @Post()
    @Returns(mailDraftView)
    create(@Body() body: CreateMailDraftDto): Promise<MailDraftView> {
        return this.drafts.create(body);
    }

    /**
     * Saves the draft's content over `version`. A draft saved elsewhere since is `409` with the version it is
     * now (`details.version`): read it, then save over that one or keep it.
     */
    @Requires('email:send')
    @Put(':draftId')
    @Returns(mailDraftView)
    save(@Param('draftId', ParseUUIDPipe) draftId: string, @Body() body: SaveMailDraftDto): Promise<MailDraftView> {
        return this.drafts.save(draftId, body);
    }

    /** Discards the draft. */
    @Requires('email:send')
    @HttpCode(204)
    @Delete(':draftId')
    remove(@Param('draftId', ParseUUIDPipe) draftId: string): Promise<void> {
        return this.drafts.remove(draftId);
    }
}
