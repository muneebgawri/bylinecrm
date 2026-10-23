import { Injectable } from '@nestjs/common';
import type { RecordTarget } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ApiException, StateConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { paginate } from '../records/list-query';
import { readableTargets } from '../records/targets';
import type { MailDraftContent } from './dto';
import { aboutRecord } from './record-about';
import type { MailDraftPage, MailDraftView } from './responses';

/** A reply's draft reads the thread of the message it answers, so its line can open that thread. */
const WITH_THREAD = { replyTo: { select: { threadId: true } } } as const;
type DraftRow = Prisma.MailDraftGetPayload<{ include: typeof WITH_THREAD }>;

/**
 * Composer drafts: the message a member is writing — on a record, or as a reply in a thread — kept as they write
 * (the composer saves a moment after each change, and on leaving) so nothing is lost to a closed panel, a reload or
 * a crash. A draft is its author's alone — the workspace's row-level security, and every query here by the caller's
 * member — and one per composer: a person's, a person's on a deal, or a reply to one message (`409` for a second;
 * the composer then reads the one there is).
 *
 * Each save names the version it replaces; a draft saved meanwhile elsewhere (another tab) is a `409` naming the
 * version it is now, never a silent overwrite — the composer offers to load that one or keep its own. Sending or
 * scheduling the message deletes its draft in the send's own transaction (`MailSendService.compose`).
 */
@Injectable()
export class MailDraftsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    /** The caller's drafts about a record (a company's: its people's), last edited first. */
    async list(target: RecordTarget, limit: number, cursor: string | undefined): Promise<MailDraftPage> {
        const context = this.current();
        const author = authorOf(context);
        return this.rls.withWorkspace(async (tx) => {
            if ((await readableTargets(tx, [target])).length === 0) {
                throw new ApiException(404, 'not_found', 'target not found');
            }
            const about = await aboutRecord(tx, target);
            if (!about) return { items: [], nextCursor: null };
            const page = await paginate(limit, cursor, (args) =>
                tx.mailDraft.findMany({
                    where: { ...about, authorMemberId: author },
                    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                    include: WITH_THREAD,
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    async get(id: string): Promise<MailDraftView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await ownDraft(tx, context, id)));
    }

    /**
     * A new draft in one composer — about a person the caller can read, and a deal they can read when it is
     * written from one; a reply's, to a message in a mailbox of the caller's own (the one rule a reply's send has:
     * it goes from a mailbox the message is in). A draft there already is a `409` naming it (`details.draftId`).
     */
    async create(input: {
        personId: string;
        dealId?: string | undefined;
        replyToMessageId?: string | undefined;
        content: MailDraftContent;
    }): Promise<MailDraftView> {
        const context = this.current();
        const author = authorOf(context);
        const dealId = input.dealId ?? null;
        const replyToMessageId = input.replyToMessageId ?? null;
        try {
            return await this.rls.withWorkspace(async (tx) => {
                const targets: RecordTarget[] = [
                    { type: 'person', id: input.personId },
                    ...(dealId ? [{ type: 'opportunity' as const, id: dealId }] : []),
                ];
                if ((await readableTargets(tx, targets)).length !== targets.length) {
                    throw new ApiException(404, 'not_found', dealId ? 'person or deal not found' : 'person not found');
                }
                if (replyToMessageId) {
                    const held = await tx.mailMessageCopy.count({
                        where: { messageId: replyToMessageId, mailbox: { ownerMemberId: author } },
                    });
                    if (held === 0) throw new ApiException(404, 'not_found', 'message not found');
                }
                const row = await tx.mailDraft.create({
                    data: {
                        workspaceId: context.workspaceId,
                        authorMemberId: author,
                        personId: input.personId,
                        dealId,
                        replyToMessageId,
                        content: input.content as Prisma.InputJsonValue,
                    },
                    include: WITH_THREAD,
                });
                return view(row);
            });
        } catch (error) {
            if (!uniqueViolation(error)) throw error;
            const existing = await this.rls.withWorkspace((tx) =>
                tx.mailDraft.findFirst({
                    where: { authorMemberId: author, personId: input.personId, dealId, replyToMessageId },
                    select: { id: true, version: true },
                }),
            );
            throw new StateConflict('you already have a draft here', {
                ...(existing ? { draftId: existing.id, version: existing.version } : {}),
            });
        }
    }

    /**
     * The draft's new content, replacing `version` — the write is conditional on it, so a save made meanwhile
     * elsewhere is a `409` naming the version it is now (`details.version`). Content that would not change is
     * nothing written: the version stays.
     */
    async save(id: string, input: { version: number; content: MailDraftContent }): Promise<MailDraftView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const current = await ownDraft(tx, context, id);
            if (current.version !== input.version) throw stale(current);
            if (JSON.stringify(current.content) === JSON.stringify(input.content)) return view(current);
            const written = await tx.mailDraft.updateMany({
                where: { id, authorMemberId: current.authorMemberId, version: current.version },
                data: { content: input.content as Prisma.InputJsonValue, version: { increment: 1 } },
            });
            const now = await ownDraft(tx, context, id);
            if (written.count === 0) throw stale(now);
            return view(now);
        });
    }

    /** Discards the caller's draft. */
    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            await ownDraft(tx, context, id);
            await deleteOwnDraft(tx, context, id);
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('MailDraftsService is used inside a workspace scope');
        return context;
    }
}

/**
 * Deletes the caller's draft `id`, if it is still there — the one way a draft goes, discarded or sent. Another
 * member's draft is never touched: it is not theirs to delete.
 */
export async function deleteOwnDraft(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<void> {
    if (!context.memberId) return;
    await tx.mailDraft.deleteMany({ where: { id, authorMemberId: context.memberId } });
}

/** A draft is written by a member: an API key has no composer. */
function authorOf(context: WorkspaceRunContext): string {
    if (!context.memberId) throw new ApiException(403, 'forbidden', 'drafts are a member’s own');
    return context.memberId;
}

/** The caller's draft, or `404` — another member's reads as missing, as it would on any record route. */
async function ownDraft(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<DraftRow> {
    const row = await tx.mailDraft.findFirst({
        where: { id, authorMemberId: authorOf(context) },
        include: WITH_THREAD,
    });
    if (!row) throw new ApiException(404, 'not_found', 'draft not found');
    return row;
}

function stale(row: DraftRow): StateConflict {
    return new StateConflict(`the draft was saved elsewhere since; it is now version ${row.version}`, {
        draftId: row.id,
        version: row.version,
    });
}

function view(row: DraftRow): MailDraftView {
    return {
        id: row.id,
        personId: row.personId,
        dealId: row.dealId,
        replyToMessageId: row.replyToMessageId,
        threadId: row.replyTo?.threadId ?? null,
        content: row.content as MailDraftContent,
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
