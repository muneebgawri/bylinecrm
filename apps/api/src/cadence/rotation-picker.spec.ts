import { defaultCadenceDays } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { warnAt } from './cadence.service';
import { eligible, pausedAt, pick, round, type RotationCandidate } from './rotation-picker';

const now = new Date('2026-10-21T12:00:00Z');
const rep = (memberId: string, extra: Partial<RotationCandidate> = {}): RotationCandidate => ({
    memberId,
    included: true,
    paused: false,
    resumeAt: null,
    weight: 1,
    hasMailbox: true,
    openLeads: 0,
    ...extra,
});
const rules = { mailboxPreference: 'prefer', openLeadCap: null };

describe('CADENCE-1 rotation picker', () => {
    it('deals in a stable order, round after round', () => {
        const turns = round([rep('b'), rep('a'), rep('c')]);
        expect(turns).toEqual(['a', 'b', 'c']);
        let cursor = 0;
        const dealt: string[] = [];
        for (let i = 0; i < 4; i++) {
            const next = pick(turns, cursor, new Set())!;
            dealt.push(next.memberId);
            cursor = next.cursor;
        }
        expect(dealt).toEqual(['a', 'b', 'c', 'a']);
    });

    it('weights spread a member’s extra turns through the round', () => {
        expect(round([rep('a', { weight: 2 }), rep('b'), rep('c', { weight: 3 })])).toEqual([
            'a',
            'b',
            'c',
            'a',
            'c',
            'c',
        ]);
    });

    it('skips an excluded member (the previous owner) and moves the pointer past whom it dealt', () => {
        expect(pick(['a', 'b', 'c'], 0, new Set(['a']))).toEqual({ memberId: 'b', cursor: 2 });
        expect(pick(['a'], 5, new Set(['a']))).toBeNull();
        expect(pick([], 0, new Set())).toBeNull();
    });

    it('leaves out the excluded, the paused (until their resume date), the capped, and the mailbox-less when required', () => {
        const all = [
            rep('in'),
            rep('out', { included: false }),
            rep('paused', { paused: true }),
            rep('resumed', { paused: true, resumeAt: new Date('2026-10-20T00:00:00Z') }),
            rep('full', { openLeads: 5 }),
            rep('nomail', { hasMailbox: false }),
        ];
        expect(eligible(all, { mailboxPreference: 'require', openLeadCap: 5 }, now).map((c) => c.memberId)).toEqual([
            'in',
            'resumed',
        ]);
        expect(eligible(all, { mailboxPreference: 'ignore', openLeadCap: null }, now)).toHaveLength(4);
        expect(pausedAt({ paused: true, resumeAt: new Date('2026-10-22T00:00:00Z') }, now)).toBe(true);
    });

    it('prefers members with a mailbox only while someone has one', () => {
        expect(eligible([rep('a'), rep('b', { hasMailbox: false })], rules, now).map((c) => c.memberId)).toEqual(['a']);
        expect(eligible([rep('b', { hasMailbox: false })], rules, now).map((c) => c.memberId)).toEqual(['b']);
    });
});

describe('CADENCE-1 cadence', () => {
    it('warns from the due date, or from the switch-on when later (no backlog rotates at once)', () => {
        const due = new Date('2026-10-01T00:00:00Z');
        const on = new Date('2026-10-20T00:00:00Z');
        expect(warnAt(due, on, 0).toISOString()).toBe('2026-10-20T00:00:00.000Z');
        expect(warnAt(on, due, 2).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    });

    it('defaults per stage: the owner’s numbers, 3 for any other open stage, none when closed', () => {
        expect(defaultCadenceDays('New Opportunity', 'open')).toBe(1);
        expect(defaultCadenceDays('Proposal Sent', 'open')).toBe(5);
        expect(defaultCadenceDays('Negotiation', 'open')).toBe(3);
        expect(defaultCadenceDays('Discovery', 'open')).toBe(3);
        expect(defaultCadenceDays('Won', 'won')).toBeNull();
    });
});
