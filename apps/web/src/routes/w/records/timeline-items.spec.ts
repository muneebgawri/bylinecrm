import { describe, expect, it } from 'vitest';
import type { TimelineActivityView } from '../../../api/types';
import { fieldLabel, wordsFor } from './timeline-items';

const OWN = { type: 'person' as const, id: 'p1' };
const names = { members: new Map([['m1', 'Kate Morgan']]), own: OWN, recordNames: new Map([['p2', 'Sam Okafor']]) };

function entry(partial: Partial<TimelineActivityView>): TimelineActivityView {
    return {
        id: 'a1',
        target: OWN,
        kind: 'person.updated',
        happenedAt: '2026-10-09T09:12:00Z',
        actor: { kind: 'member', id: 'm1' },
        properties: {},
        linked: null,
        createdAt: '2026-10-09T09:12:00Z',
        ...partial,
    };
}

describe('wordsFor', () => {
    it('FR-CRMS-4: reads stored mail by its sender and subject, and points at its thread', () => {
        const email = (direction: string) => ({
            email: {
                direction,
                subject: 'Intro',
                snippet: 'Hi',
                from: 'dana@acme.com',
                threadId: 'th-1',
                mailboxId: 'mb-1',
            },
        });
        const received = wordsFor(
            entry({ kind: 'linked-email.received', actor: { kind: 'sync', id: null }, properties: email('inbound') }),
            names,
        );
        expect(received).toMatchObject({
            actor: 'dana@acme.com',
            action: 'wrote “Intro”',
            family: 'mail',
            threadId: 'th-1',
        });
        const sent = wordsFor(entry({ kind: 'linked-email.sent', properties: email('outbound') }), names);
        expect(sent).toMatchObject({ actor: 'Kate Morgan', action: 'sent “Intro”', family: 'mail' });
    });

    it('names the member and lists the changed fields of an update', () => {
        const words = wordsFor(entry({ properties: { diff: { nameFirst: {}, city: {} } } }), names);
        expect(words.actor).toBe('Kate Morgan');
        expect(words.action).toBe('updated the person');
        expect(words.detail?.map((d) => d.label)).toEqual(['first name', 'city']);
    });

    it('reads a linked note as "added a note: title"', () => {
        const words = wordsFor(entry({ kind: 'linked-note.created', properties: { name: 'Met at FinCon' } }), names);
        expect(words.action).toBe('added a note: Met at FinCon');
        expect(words.family).toBe('note');
    });

    it('reads an external event by its title and shows the amount', () => {
        const words = wordsFor(
            entry({
                kind: 'external.order_paid',
                actor: { kind: 'external', id: 'newswire' },
                properties: { title: 'paid an order', amount: { amountMinor: 120000, currency: 'USD' } },
            }),
            names,
        );
        expect(words.actor).toBe('newswire');
        expect(words.action).toBe('paid an order');
        expect(words.detail?.[0]?.label).toMatch(/1,200/);
    });

    it('reads a rule-made stage move with both stages', () => {
        const words = wordsFor(
            entry({
                kind: 'deal.stage_changed',
                actor: { kind: 'rule', id: 'r1' },
                properties: { diff: { stageId: { from: 's1', to: 's2' } } },
            }),
            {
                ...names,
                stages: new Map([
                    ['s1', 'Contacted'],
                    ['s2', 'Replied'],
                ]),
            },
        );
        expect(words.actor).toBe('A rule');
        expect(words.family).toBe('stage');
        expect(words.detail?.map((d) => d.label)).toEqual(['Contacted', 'Replied']);
    });

    it('marks an entry from another record on a merged timeline', () => {
        const words = wordsFor(entry({ target: { type: 'person', id: 'p2' } }), {
            ...names,
            own: { type: 'company', id: 'c1' },
        });
        expect(words.origin).toBe('Person: Sam Okafor');
    });

    it('labels fields one way', () => {
        expect(fieldLabel('nameFirst')).toBe('first name');
        expect(fieldLabel('custom.lastOutlet')).toBe('last outlet');
    });
});
