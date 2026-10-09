import { Injectable } from '@nestjs/common';
import { normaliseBlocklistValue, type BlocklistScope } from '@bylinecrm/shared';
import { ApiException, UniqueConflict, ValidationFailed } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import type { BlocklistEntryView } from './responses';

/**
 * The blocklist (PAR-017): addresses or `@domains` whose mail is not imported. A member keeps
 * their own (personal: it applies to the mailboxes they own); an admin keeps the workspace's
 * (every mailbox). Each sees the workspace's entries and their own — never another member's.
 * Entries apply to mail synced from then on; what is already stored stays.
 */
@Injectable()
export class BlocklistService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
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

    async create(input: { value: string; scope: BlocklistScope }): Promise<BlocklistEntryView> {
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
            const row = await this.rls.withWorkspace((tx) =>
                tx.blocklistEntry.create({
                    data: {
                        workspaceId: context.workspaceId,
                        memberId: input.scope === 'personal' ? context.memberId! : null,
                        value,
                        createdById: context.memberId ?? null,
                    },
                }),
            );
            return view(row);
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
