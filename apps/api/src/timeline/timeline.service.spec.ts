import type { DomainEvent } from '@bylinecrm/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RlsPrismaService, WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceContext } from '../infra/workspace-context';
import { TimelineService } from './timeline.service';
import type { CustomFieldsService } from '../records/custom-fields/custom-fields.service';

/**
 * The fan-out rule (PAR-014) without a database: a record's own event leaves one row on the
 * record; a note's event leaves one row on each record it is on, naming the note; a diff travels
 * from the event into `properties` untouched; an event with nothing to attach to leaves nothing;
 * every row carries the outbox event's id and the write skips rows that exist (P1-6).
 */
describe('TimelineService.writeFor', () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const eventId = '88888888-8888-4888-8888-888888888888';
    const delivered = (event: DomainEvent) => ({ id: eventId, event });
    const actor = { kind: 'member', id: '22222222-2222-4222-8222-222222222222' } as const;

    function harness(noteTitle: string | null = 'FinCon') {
        const created: unknown[] = [];
        const tx = {
            timelineActivity: {
                createMany: vi.fn(async ({ data, skipDuplicates }: { data: unknown[]; skipDuplicates?: boolean }) => {
                    // A redelivered event must not write twice (P1-6): every write skips what exists.
                    expect(skipDuplicates).toBe(true);
                    created.push(...data);
                    return { count: data.length };
                }),
            },
            note: { findUnique: vi.fn(async () => (noteTitle === null ? null : { title: noteTitle })) },
            task: { findUnique: vi.fn(async () => null) },
            attachment: { findUnique: vi.fn(async () => null) },
        } as unknown as WorkspaceClient;
        const rls = {
            withWorkspace: vi.fn(async (id: string, fn: (tx: WorkspaceClient) => Promise<unknown>) => {
                expect(id).toBe(workspaceId);
                return fn(tx);
            }),
        } as unknown as RlsPrismaService;
        const context = { get: () => undefined } as unknown as WorkspaceContext;
        return {
            service: new TimelineService(rls, context, { restricted: () => false } as unknown as CustomFieldsService),
            created,
            tx,
        };
    }

    it('writes one entry on the record for its own event, carrying the diff as given', async () => {
        const { service, created } = harness();
        const event: DomainEvent = {
            type: 'person.updated',
            object: 'person',
            workspaceId,
            actor,
            occurredAt: '2026-10-09T10:00:00.000Z',
            recordId: '33333333-3333-4333-8333-333333333333',
            diff: { nameFirst: { from: 'Dan', to: 'Dana' } },
        };
        expect(await service.writeFor(delivered(event))).toBe(1);
        expect(created).toEqual([
            expect.objectContaining({
                workspaceId,
                eventId,
                targetType: 'person',
                targetId: event.recordId,
                kind: 'person.updated',
                happenedAt: new Date(event.occurredAt),
                actor,
                properties: { diff: event.diff },
            }),
        ]);
        expect((created[0] as { linkedType?: unknown }).linkedType).toBeUndefined();
    });

    it('writes one entry per target for a note, naming the note once for all of them', async () => {
        const { service, created, tx } = harness('FinCon');
        const targets = [
            { type: 'person' as const, id: '44444444-4444-4444-8444-444444444444' },
            { type: 'company' as const, id: '55555555-5555-4555-8555-555555555555' },
        ];
        const event: DomainEvent = {
            type: 'note.created',
            object: 'note',
            workspaceId,
            actor,
            occurredAt: '2026-10-09T10:00:00.000Z',
            recordId: '66666666-6666-4666-8666-666666666666',
            targets,
        };
        expect(await service.writeFor(delivered(event))).toBe(2);
        expect(created.map((r) => (r as { targetType: string; targetId: string }).targetId)).toEqual(
            targets.map((t) => t.id),
        );
        for (const row of created) {
            expect(row).toEqual(
                expect.objectContaining({
                    kind: 'linked-note.created',
                    linkedType: 'note',
                    linkedId: event.recordId,
                    properties: { linked: { type: 'note', id: event.recordId, name: 'FinCon' } },
                }),
            );
        }
        expect((tx.note.findUnique as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it('records a linked thing that is already gone with a null name, and nothing with no targets', async () => {
        const { service, created } = harness(null);
        const base = {
            workspaceId,
            actor,
            occurredAt: '2026-10-09T10:00:00.000Z',
            recordId: '77777777-7777-4777-8777-777777777777',
        };
        expect(
            await service.writeFor(
                delivered({
                    ...base,
                    type: 'note.deleted',
                    object: 'note',
                    targets: [{ type: 'person', id: '44444444-4444-4444-8444-444444444444' }],
                }),
            ),
        ).toBe(1);
        expect((created[0] as { properties: { linked: { name: unknown } } }).properties.linked.name).toBeNull();
        expect(await service.writeFor(delivered({ ...base, type: 'note.restored', object: 'note' }))).toBe(0);
        expect(created).toHaveLength(1);
    });
});
