import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { assertNotCooling, coolingUnlocksAt } from './transfer-cooling';

const NOW = new Date('2026-10-21T12:00:00Z');

/** A client whose settings row and last matching transfer are given; it records the transfer query it was asked. */
function client(days: number | null, lastDecidedAt: Date | null) {
    const findTransfer = vi.fn().mockResolvedValue(lastDecidedAt ? { decidedAt: lastDecidedAt } : null);
    const tx = {
        ownershipSettings: {
            findFirst: vi.fn().mockResolvedValue(days === null ? null : { transferCoolingDays: days }),
        },
        ownershipTransfer: { findFirst: findTransfer },
    } as unknown as WorkspaceClient;
    return { tx, findTransfer };
}

const input = { object: 'company' as const, recordId: 'c-1', memberId: 'm-ana', memberName: 'Ana', now: NOW };

describe('the transfer cooling period (OWN-1, owner decision 2)', () => {
    it('FR-CRMS-17: refuses a record going back to the member it left, naming the day it unlocks', async () => {
        const left = new Date('2026-10-20T09:30:00Z');
        const { tx, findTransfer } = client(null, left);
        const refusal = await assertNotCooling(tx, input).catch((e: unknown) => e);
        expect(refusal).toMatchObject({
            code: 'conflict.transfer_cooling',
            details: { unlocksAt: '2026-11-03T09:30:00.000Z', coolingDays: 14 },
        });
        expect((refusal as Error).message).toContain('Ana');
        expect((refusal as Error).message).toContain('2026-11-03');

        // It asks for completed transfers away from that member, inside the window, of the record or its unit.
        const where = (findTransfer.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
        expect(where).toMatchObject({
            fromMemberId: 'm-ana',
            status: { in: ['accepted', 'forced'] },
            decidedAt: { gt: new Date('2026-10-07T12:00:00Z') },
            OR: [
                { object: 'company', recordId: 'c-1' },
                { moved: { array_contains: [{ type: 'company', id: 'c-1' }] } },
            ],
        });
    });

    it('lets it through when nothing left the member in the window, or the workspace turned the period off', async () => {
        await expect(assertNotCooling(client(14, null).tx, input)).resolves.toBeUndefined();
        const off = client(0, new Date('2026-10-21T11:00:00Z'));
        await expect(assertNotCooling(off.tx, input)).resolves.toBeUndefined();
        expect(off.findTransfer).not.toHaveBeenCalled();
    });

    it('speaks to the member themselves when they are the one accepting', async () => {
        const { tx } = client(7, new Date('2026-10-20T00:00:00Z'));
        await expect(assertNotCooling(tx, { ...input, memberName: null })).rejects.toThrow(
            /away from you less than 7 days ago\. You can take it back from 2026-10-27/,
        );
        expect(coolingUnlocksAt(new Date('2026-10-20T00:00:00Z'), 7).toISOString()).toBe('2026-10-27T00:00:00.000Z');
    });
});
