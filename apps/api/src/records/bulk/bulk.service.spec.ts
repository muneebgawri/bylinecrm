import { ForbiddenException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { BULK_CHUNK_SIZE, BULK_MAX_IDS, type DomainEvent } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import type { DomainEvents } from '../../events/domain-events.service';
import type { RlsPrismaService, WorkspaceClient } from '../../infra/rls-prisma.service';
import type { WorkspaceContext, WorkspaceRunContext } from '../../infra/workspace-context';
import type { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { BulkService, chunked, distinctIds, type BulkRecords } from './bulk.service';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const MEMBER = uuid(900_001);
const OTHER = uuid(900_002);

/**
 * A fake world: rows visible to the caller, transactions counted, events captured. The
 * transaction client answers only what the bulk service asks — which ids are actionable, and
 * whether an owner is a member — so the service's own logic is what is under test.
 */
function harness(options: {
    visible: Set<string>;
    ownerScope?: string;
    vanishOnWrite?: Set<string>;
    /** Ids whose owner already is the one asked for: the single update reports no change. */
    alreadyOwned?: Set<string>;
}) {
    const transactions: string[][] = [];
    const published: DomainEvent[] = [];
    const writes: { action: string; id: string; ownerId?: string | null }[] = [];
    let current: string[] = [];

    const tx = {
        person: {
            findMany: ({ where }: { where: { id: { in: string[] } } }) =>
                Promise.resolve(where.id.in.filter((id) => options.visible.has(id)).map((id) => ({ id }))),
        },
        workspaceMember: {
            findUnique: ({ where }: { where: { id: string } }) =>
                Promise.resolve([MEMBER, OTHER].includes(where.id) ? { id: where.id } : null),
        },
    } as unknown as WorkspaceClient;

    const rls = {
        withWorkspace: async <T>(fn: (tx: WorkspaceClient) => Promise<T>) => {
            current = [];
            const result = await fn(tx);
            transactions.push(current);
            return result;
        },
    } as unknown as RlsPrismaService;

    const context: WorkspaceRunContext = {
        workspaceId: uuid(1),
        memberId: MEMBER,
        capabilities: new Set(['record:write']),
        ...(options.ownerScope ? { ownerScopeMemberId: options.ownerScope } : {}),
    };
    const contexts = { get: () => context } as unknown as WorkspaceContext;
    // Events are recorded in the chunk's own transaction (P1-6): with its client, before it commits.
    const events = {
        recordAll: async (client: WorkspaceClient, recorded: readonly DomainEvent[]) => {
            expect(client).toBe(tx);
            published.push(...recorded);
        },
    } as unknown as DomainEvents;

    const announce = (type: DomainEvent['type'], id: string): { event: DomainEvent } => ({
        event: {
            type,
            object: 'person',
            workspaceId: context.workspaceId,
            actor: { kind: 'member', id: MEMBER },
            occurredAt: '2026-10-09T00:00:00.000Z',
            recordId: id,
        } as DomainEvent,
    });
    const step = (action: string, id: string, ownerId?: string | null) => {
        if (options.vanishOnWrite?.has(id)) throw new NotFoundException('person not found');
        current.push(id);
        writes.push({ action, id, ...(ownerId !== undefined ? { ownerId } : {}) });
    };
    const records: BulkRecords = {
        object: 'person',
        updateIn: (_tx, _ctx, id, patch) => {
            if (options.alreadyOwned?.has(id)) return Promise.resolve({ event: null });
            step('assign_owner', id, patch.ownerId);
            return Promise.resolve(announce('person.updated', id));
        },
        removeIn: (_tx, _ctx, id) => {
            step('delete', id);
            return Promise.resolve(announce('person.deleted', id));
        },
        restoreIn: (_tx, _ctx, id) => {
            step('restore', id);
            return Promise.resolve(announce('person.restored', id));
        },
    };
    const service = new BulkService(rls, contexts, {} as CustomFieldsService, events);
    return { service, records, transactions, published, writes };
}

describe('bulk helpers', () => {
    it('distinctIds keeps the first occurrence of each id, in order', () => {
        expect(distinctIds(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
    });

    it('chunked splits in order with a short last run', () => {
        expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });
});

describe('BulkService', () => {
    it('acts on the visible ids, reports the rest as not_found, in the order named', async () => {
        const ids = [uuid(3), uuid(1), uuid(2)];
        const h = harness({ visible: new Set([uuid(1), uuid(3)]) });
        const result = await h.service.run(h.records, { action: 'delete', ids });
        expect(result.results).toEqual([
            { id: uuid(3), ok: true },
            { id: uuid(1), ok: true },
            { id: uuid(2), ok: false, error: 'not_found' },
        ]);
        expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    });

    it(`changes ${BULK_CHUNK_SIZE} records per transaction and publishes one event per changed record`, async () => {
        const ids = Array.from({ length: 2 * BULK_CHUNK_SIZE + 7 }, (_, i) => uuid(i + 10));
        const h = harness({ visible: new Set(ids) });
        await h.service.run(h.records, { action: 'restore', ids });
        // One transaction checks the owner / resolves the ids, then one per chunk.
        expect(h.transactions.slice(1).map((t) => t.length)).toEqual([BULK_CHUNK_SIZE, BULK_CHUNK_SIZE, 7]);
        expect(h.published).toHaveLength(ids.length);
        expect(h.published.every((e) => e.type === 'person.restored')).toBe(true);
    });

    it('names a duplicated id once', async () => {
        const h = harness({ visible: new Set([uuid(1)]) });
        const result = await h.service.run(h.records, { action: 'delete', ids: [uuid(1), uuid(1)] });
        expect(result.results).toEqual([{ id: uuid(1), ok: true }]);
        expect(h.writes).toHaveLength(1);
    });

    it(`answers more than ${BULK_MAX_IDS} distinct ids with 413 before any change`, async () => {
        const ids = Array.from({ length: BULK_MAX_IDS + 1 }, (_, i) => uuid(i + 10));
        const h = harness({ visible: new Set(ids) });
        await expect(h.service.run(h.records, { action: 'delete', ids })).rejects.toBeInstanceOf(
            PayloadTooLargeException,
        );
        expect(h.transactions).toHaveLength(0);
    });

    it('a record that vanishes between the check and the write is not_found, and the rest still change', async () => {
        const h = harness({ visible: new Set([uuid(1), uuid(2)]), vanishOnWrite: new Set([uuid(1)]) });
        const result = await h.service.run(h.records, { action: 'delete', ids: [uuid(1), uuid(2)] });
        expect(result.results).toEqual([
            { id: uuid(1), ok: false, error: 'not_found' },
            { id: uuid(2), ok: true },
        ]);
        expect(h.published.map((e) => e.recordId)).toEqual([uuid(2)]);
    });

    it('assigns through the single-record update, with the owner checked once', async () => {
        const h = harness({ visible: new Set([uuid(1), uuid(2)]) });
        await h.service.run(h.records, { action: 'assign_owner', ids: [uuid(1), uuid(2)], ownerId: OTHER });
        expect(h.writes).toEqual([
            { action: 'assign_owner', id: uuid(1), ownerId: OTHER },
            { action: 'assign_owner', id: uuid(2), ownerId: OTHER },
        ]);
    });

    it('a record already owned as asked is ok and unchanged, and announced by nothing', async () => {
        const h = harness({ visible: new Set([uuid(1), uuid(2)]), alreadyOwned: new Set([uuid(1)]) });
        const result = await h.service.run(h.records, {
            action: 'assign_owner',
            ids: [uuid(1), uuid(2)],
            ownerId: OTHER,
        });
        expect(result.results).toEqual([
            { id: uuid(1), ok: true, unchanged: true },
            { id: uuid(2), ok: true },
        ]);
        expect(result).toMatchObject({ succeeded: 2, failed: 0 });
        expect(h.published.map((e) => e.recordId)).toEqual([uuid(2)]);
    });

    it('an own-scoped caller may only assign to themselves — refused before anything changes', async () => {
        const h = harness({ visible: new Set([uuid(1)]), ownerScope: MEMBER });
        await expect(
            h.service.run(h.records, { action: 'assign_owner', ids: [uuid(1)], ownerId: OTHER }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.writes).toHaveLength(0);
        await h.service.run(h.records, { action: 'assign_owner', ids: [uuid(1)], ownerId: MEMBER });
        expect(h.writes).toHaveLength(1);
    });
});
