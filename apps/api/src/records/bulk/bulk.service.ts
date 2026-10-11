import { Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import {
    type BulkAction,
    BULK_CHUNK_SIZE,
    BULK_MAX_IDS,
    type BulkResult,
    type BulkRowResult,
    type DomainEvent,
    type FilterGroup,
    type RecordObject,
} from '@bylinecrm/shared';
import { DomainEvents } from '../../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../../infra/workspace-context';
import { listScope } from '../../query/query.service';
import { rowIds } from '../../query/rows';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { recordWhere, resolveOwner } from '../record-scope';
import { assertOwnerIsMember } from '../references';

/**
 * A record object as the bulk service acts on it: its own single-record writes, run inside the
 * bulk service's transaction, each returning the event it would announce on its own. The record
 * services implement this — a record changed in bulk is changed by the very code a single route
 * runs, and announced by the very same event.
 */
export interface BulkRecords {
    readonly object: RecordObject;
    /** `event: null` when the record already was as asked — nothing written, nothing announced. */
    updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: { ownerId: string | null },
    ): Promise<{ event: DomainEvent | null }>;
    removeIn(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<{ event: DomainEvent }>;
    restoreIn(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<{ event: DomainEvent }>;
}

/** One bulk request: an action over named ids, or over the records a list request selects. */
export interface BulkRequest {
    action: BulkAction;
    ids?: string[] | undefined;
    filter?: FilterGroup | undefined;
    view?: string | undefined;
    q?: string | undefined;
    /** `assign_owner` only: the member to own the records, or `null` for nobody. */
    ownerId?: string | null | undefined;
}

/** Ids in the order first named, each once. */
export function distinctIds(ids: readonly string[]): string[] {
    return [...new Set(ids)];
}

/** `ids` in runs of `size`, in order. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function tooMany(count: number | string): PayloadTooLargeException {
    return new PayloadTooLargeException(
        `a bulk request acts on at most ${BULK_MAX_IDS} records; this one names ${count}. Split it.`,
    );
}

/**
 * Bulk actions on one object's records (P1-4a). Every record goes through its object's own
 * single-record write, so each change is checked and announced as if made alone: N records
 * changed means N `…updated`/`…deleted`/`…restored` events, never one bulk event.
 *
 * - **What it acts on:** named ids (at most `BULK_MAX_IDS`, duplicates once), or the records a
 *   list request (filter / view / search) selects — counted first, and refused with `413` past
 *   `BULK_MAX_IDS` rather than cut short.
 * - **Chunks:** `BULK_CHUNK_SIZE` records per transaction; each chunk's events are recorded in
 *   that transaction (P1-6), so they exist exactly when its changes committed.
 * - **What it reports:** one result per record, in the order named. A record the caller cannot
 *   act on in this state — another owner's, another workspace's, already deleted, never existed —
 *   is `{ ok: false, error: 'not_found' }`, the same answer whatever the reason, so the response
 *   cannot be used to learn what exists outside the caller's sight.
 * - **Owner:** checked once for the whole request — an own-scoped caller may only name
 *   themselves (`403`), and the owner must be a member (`422`) — before any record changes.
 */
@Injectable()
export class BulkService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
    ) {}

    async run(records: BulkRecords, request: BulkRequest): Promise<BulkResult> {
        const context = this.current();
        const deleted = request.action === 'restore';
        const ownerId =
            request.action === 'assign_owner' ? resolveOwner(context, request.ownerId ?? null, undefined) : undefined;
        const named = request.ids ? distinctIds(request.ids) : undefined;
        if (named && named.length > BULK_MAX_IDS) throw tooMany(named.length);

        const ids = await this.rls.withWorkspace(async (tx) => {
            if (ownerId !== undefined) await assertOwnerIsMember(tx, ownerId);
            return named ?? (await this.selected(tx, context, records.object, request, deleted));
        });

        const results = new Map<string, BulkRowResult>();
        for (const chunk of chunked(ids, BULK_CHUNK_SIZE)) {
            const rows = await this.rls.withWorkspace(async (tx) => {
                const applied = await this.applyChunk(
                    tx,
                    context,
                    records,
                    request.action,
                    chunk,
                    deleted,
                    ownerId ?? null,
                );
                await this.events.recordAll(tx, applied.events);
                return applied.rows;
            });
            for (const row of rows) results.set(row.id, row);
        }

        const ordered = ids.map((id) => results.get(id)!);
        const succeeded = ordered.filter((r) => r.ok).length;
        return { results: ordered, succeeded, failed: ordered.length - succeeded };
    }

    /** The records a list request selects in this state, in the list's order — or `413` past the limit. */
    private async selected(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        object: RecordObject,
        request: BulkRequest,
        deleted: boolean,
    ): Promise<string[]> {
        const scope = await listScope(tx, context, this.customFields, object, request, deleted);
        if (scope.empty) return [];
        const ids = await rowIds(tx, object, scope.where, scope.plan.orderBy, BULK_MAX_IDS + 1);
        if (ids.length > BULK_MAX_IDS) throw tooMany(`more than ${BULK_MAX_IDS}`);
        return ids;
    }

    private async applyChunk(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        records: BulkRecords,
        action: BulkAction,
        chunk: string[],
        deleted: boolean,
        ownerId: string | null,
    ): Promise<{ rows: BulkRowResult[]; events: DomainEvent[] }> {
        const actionable = new Set(
            await rowIds(tx, records.object, { id: { in: chunk }, ...recordWhere(context, deleted) }, [], chunk.length),
        );
        const rows: BulkRowResult[] = [];
        const events: DomainEvent[] = [];
        for (const id of chunk) {
            if (!actionable.has(id)) {
                rows.push({ id, ok: false, error: 'not_found' });
                continue;
            }
            try {
                const { event } = await write(records, action, tx, context, id, ownerId);
                if (event) {
                    events.push(event);
                    rows.push({ id, ok: true });
                } else {
                    rows.push({ id, ok: true, unchanged: true });
                }
            } catch (error) {
                // Gone between the check and the write (another request deleted it): the same answer.
                if (!(error instanceof NotFoundException)) throw error;
                rows.push({ id, ok: false, error: 'not_found' });
            }
        }
        return { rows, events };
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('BulkService is used inside a workspace scope');
        return context;
    }
}

function write(
    records: BulkRecords,
    action: BulkAction,
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    id: string,
    ownerId: string | null,
): Promise<{ event: DomainEvent | null }> {
    switch (action) {
        case 'assign_owner':
            return records.updateIn(tx, context, id, { ownerId });
        case 'delete':
            return records.removeIn(tx, context, id);
        case 'restore':
            return records.restoreIn(tx, context, id);
    }
}
