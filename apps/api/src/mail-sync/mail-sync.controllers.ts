import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Requires, TenantController } from '../auth/decorators';
import { WorkspaceContext } from '../infra/workspace-context';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { Returns } from '../openapi/responses';
import { parseTarget } from '../records/targets';
import { BlocklistService } from './blocklist.service';
import { CreateBlocklistEntryDto, ListThreadsQueryDto } from './dto';
import { MailReadService } from './mail-read.service';
import { MailSyncWorkers } from './mail-sync.workers';
import {
    blocklistEntryView,
    mailThreadPage,
    mailThreadView,
    mailboxSyncTriggered,
    mailboxSyncView,
    type BlocklistEntryView,
    type MailThreadSummary,
    type MailThreadView,
    type MailboxSyncTriggered,
    type MailboxSyncView,
} from './responses';
import type { Page } from '../records/list-query';

/** Synced mail on the records it concerns (P2-2). */
@ApiTags('mail')
@TenantController('mail/threads')
export class MailThreadsController {
    constructor(private readonly mail: MailReadService) {}

    /** Threads with a participant who is the record (a person), one of its people (a company) or its point of contact (a deal); newest first. */
    @Requires('record:read')
    @Get()
    @Returns(mailThreadPage)
    list(@Query() query: ListThreadsQueryDto): Promise<Page<MailThreadSummary>> {
        return this.mail.listThreads(parseTarget(query.target), query.cursor, query.limit);
    }

    /** A thread's messages, oldest first. Bodies only for the mailbox's owner, or a pool mailbox's mail. */
    @Requires('record:read')
    @Get(':threadId')
    @Returns(mailThreadView)
    get(@Param('threadId', ParseUUIDPipe) threadId: string): Promise<MailThreadView> {
        return this.mail.getThread(threadId);
    }
}

/** A mailbox's sync: where it stands, and asking for a run now. */
@ApiTags('mail')
@TenantController('mailboxes')
export class MailboxSyncController {
    constructor(
        private readonly mail: MailReadService,
        private readonly mailboxes: MailboxesService,
        private readonly workers: MailSyncWorkers,
        private readonly context: WorkspaceContext,
    ) {}

    @Requires('mailbox:read')
    @Get(':mailboxId/sync')
    @Returns(mailboxSyncView)
    state(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<MailboxSyncView> {
        return this.mail.syncState(mailboxId);
    }

    /** Queues an incremental sync now (the mailbox's owner or an admin). */
    @Requires('mailbox:manage')
    @HttpCode(202)
    @Post(':mailboxId/sync')
    @Returns(mailboxSyncTriggered)
    async trigger(@Param('mailboxId', ParseUUIDPipe) mailboxId: string): Promise<MailboxSyncTriggered> {
        await this.mailboxes.assertChangeable(mailboxId);
        const workspaceId = this.context.get()!.workspaceId;
        const queued = await this.workers.enqueue({ workspaceId, mailboxId });
        return { sync: await this.mail.readSyncState(mailboxId), queued };
    }
}

/** The blocklist: the caller's own entries and the workspace's. */
@ApiTags('mail')
@TenantController('mail/blocklist')
export class BlocklistController {
    constructor(private readonly blocklist: BlocklistService) {}

    @Requires('mailbox:read')
    @Get()
    @Returns([blocklistEntryView])
    list(): Promise<BlocklistEntryView[]> {
        return this.blocklist.list();
    }

    /** `scope: workspace` is an admin's; `personal` (the default) applies to the mailboxes the caller owns. */
    @Requires('mailbox:manage')
    @HttpCode(201)
    @Post()
    @Returns(blocklistEntryView)
    create(@Body() body: CreateBlocklistEntryDto): Promise<BlocklistEntryView> {
        return this.blocklist.create(body);
    }

    @Requires('mailbox:manage')
    @HttpCode(204)
    @Delete(':entryId')
    remove(@Param('entryId', ParseUUIDPipe) entryId: string): Promise<void> {
        return this.blocklist.remove(entryId);
    }
}
