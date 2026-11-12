import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { normaliseBlocklistValue, type BlocklistScope } from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, UniqueConflict, ValidationFailed } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { entriesFor, everyOutsideBlocked } from './blocklist-rule';
import { purgeCopies } from './purge';
import type { BlocklistEntryCreated, BlocklistEntryView } from './responses';

/**
 * The blocklist (PAR-017): addresses or `@domains` whose mail is not imported. A member keeps
 * their own (personal: it applies to the mailboxes they own); an admin keeps the workspace's
 * (every mailbox). Each sees the workspace's entries and their own — never another member's.
 * A new entry also **purges** stored mail it now fully covers — by the importer's own rule
 * (`blocklist-rule.ts`), in the mailboxes the entry applies to — with the mail's participants,
 * its timeline entries and threads left empty, in the same transaction. Removing an entry later
 * does not bring purged mail back.
 */
@Injectable()
export class BlocklistService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    list(): Promise<BlocklistEntryView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.blocklistEntry.findMany({
                where: { OR: [{ memberId: null }, ...(context.memberId ? [{ memberId: context.memberId }] : [])] },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            });
            return rows.map(view);
        });
    }

    async create(input: { value: string; scope: BlocklistScope }): Promise<BlocklistEntryCreated> {
        const context = this.current();
        const value = normaliseBlocklistValue(input.value);
        if (!value) {
            throw new ValidationFailed('the blocklist entry is not valid', [
                { path: 'value', message: 'an email address, or a domain written as @example.com' },
            ]);
        }
        if (input.scope === 'workspace' && !isAdmin(context)) {
            throw new ApiException(403, 'forbidden', "only an admin may change the workspace's blocklist");
        }
        if (input.scope === 'personal' && !context.memberId) {
            throw new ApiException(403, 'forbidden', 'an API key has no personal blocklist');
        }
        try {
            return await this.rls.withWorkspace(async (tx) => {
                const row = await tx.blocklistEntry.create({
                    data: {
                        workspaceId: context.workspaceId,
                        memberId: input.scope === 'personal' ? context.memberId! : null,
                        value,
                        createdById: context.memberId ?? null,
                    },
                });
                const { purged, events } = await purgeCovered(tx, context.workspaceId, row);
                await this.events.recordAll(tx, events);
                return { entry: view(row), purged };
            });
        } catch (error) {
            if (uniqueViolation(error)) throw new UniqueConflict('that entry is already on the blocklist', 'value');
            throw error;
        }
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const row = await tx.blocklistEntry.findUnique({ where: { id } });
            if (!row || (row.memberId !== null && row.memberId !== context.memberId)) {
                throw new ApiException(404, 'not_found', 'blocklist entry not found');
            }
            if (row.memberId === null && !isAdmin(context)) {
                throw new ApiException(403, 'forbidden', "only an admin may change the workspace's blocklist");
            }
            await tx.blocklistEntry.delete({ where: { id } });
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('blocklist used outside a workspace context');
        return context;
    }
}

/**
 * Deletes stored mail the new entry now fully covers, in the mailboxes it applies to: the
 * workspace's entry everywhere; a personal entry in its member's personal mailboxes. Each mailbox's
 * **copy** is judged with every entry that applies to that mailbox — the importer's rule — so mixed
 * mail stays. A message goes (with its participants and timeline entries) only when no mailbox holds
 * a copy of it any more (#107); a thread goes when it has no message left.
 */
async function purgeCovered(
    tx: WorkspaceClient,
    workspaceId: string,
    entry: { value: string; memberId: string | null },
): Promise<{ purged: { messages: number; threads: number }; events: DomainEvent[] }> {
    const none = { purged: { messages: 0, threads: 0 }, events: [] };
    const mailboxes = await tx.mailbox.findMany({
        where: entry.memberId === null ? {} : { ownerMemberId: entry.memberId, purpose: 'personal' },
        select: { id: true, email: true, ownerMemberId: true, purpose: true },
    });
    if (mailboxes.length === 0) return none;
    const covered = entry.value.startsWith('@') ? { endsWith: entry.value } : { equals: entry.value };
    const candidates = await tx.mailMessageCopy.findMany({
        where: {
            mailboxId: { in: mailboxes.map((m) => m.id) },
            message: { participants: { some: { address: covered } } },
        },
        select: {
            id: true,
            mailboxId: true,
            message: { select: { id: true, threadId: true, participants: { select: { address: true } } } },
        },
    });
    if (candidates.length === 0) return none;
    const entries = await tx.blocklistEntry.findMany({ select: { value: true, memberId: true } });
    const byId = new Map(mailboxes.map((m) => [m.id, m]));
    const doomed = candidates.filter((c) => {
        const mailbox = byId.get(c.mailboxId)!;
        return everyOutsideBlocked(
            mailbox.email,
            c.message.participants.map((p) => p.address),
            entriesFor(mailbox, entries),
        );
    });
    // What nothing holds any more goes with them (`purgeCopies`: one rule for every reason a copy goes).
    return purgeCopies(tx, workspaceId, doomed);
}

function isAdmin(context: WorkspaceRunContext): boolean {
    return context.capabilities.has('workspace:admin');
}

function view(row: { id: string; value: string; memberId: string | null; createdAt: Date }): BlocklistEntryView {
    return {
        id: row.id,
        value: row.value,
        scope: row.memberId === null ? 'workspace' : 'personal',
        createdAt: row.createdAt,
    };
}
