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

    it('FR-CRMS-8: reads a click as the link clicked, and an open as indicative', () => {
        const clicked = wordsFor(
            entry({
                kind: 'linked-email.clicked',
                actor: { kind: 'system', id: null },
                properties: {
                    linked: { type: 'email', id: 'send-1', name: 'The report' },
                    tracking: { url: 'https://acme.example/report', indicative: false, sequenceStepId: null },
                },
            }),
            names,
        );
        expect(clicked).toMatchObject({
            actor: 'They',
            action: 'clicked https://acme.example/report in “The report”',
            family: 'mail',
        });
        const opened = wordsFor(
            entry({
                kind: 'linked-email.opened',
                target: { type: 'person', id: 'p2' },
                actor: { kind: 'system', id: null },
                properties: {
                    linked: { type: 'email', id: 'send-1', name: 'The report' },
                    tracking: { url: null, indicative: true, sequenceStepId: null },
                },
            }),
            names,
        );
        expect(opened.actor).toBe('Sam Okafor');
        expect(opened.action).toBe('opened “The report” (indicative)');
        expect(opened.detail?.[0]?.label).toMatch(/Indicative/);
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

    it('#114 reads a suppression by its address, reason and note, and its lift with the lift note', () => {
        const linked = { type: 'suppression' as const, id: 's1' };
        const named = { linked: { ...linked, name: 'dana@acme.example' } };
        const added = wordsFor(
            entry({
                kind: 'linked-suppression.added',
                linked,
                properties: { ...named, suppression: { reason: 'hard_bounce', source: 'provider', note: null } },
            }),
            names,
        );
        expect(added.action).toBe('suppressed dana@acme.example');
        expect(added.detail).toEqual([{ label: 'Hard bounce' }]);
        const lifted = wordsFor(
            entry({
                kind: 'linked-suppression.removed',
                linked,
                properties: { ...named, suppression: { reason: 'manual', source: 'member', note: 'added by mistake' } },
            }),
            names,
        );
        expect(lifted.action).toBe('lifted the suppression of dana@acme.example');
        expect(lifted.detail).toEqual([{ label: 'Manual' }, { label: 'added by mistake' }]);
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

    it('reads a meeting from a calendar as booked by its member, with when it is — never its description', () => {
        const meeting = {
            linked: { type: 'meeting', id: 'mt1', name: 'Acme intro' },
            meeting: {
                title: 'Acme intro',
                startsAt: '2026-10-20T13:00:00Z',
                endsAt: '2026-10-20T13:30:00Z',
                allDay: false,
                conferenceUrl: 'https://meet.google.com/abc',
                hostMemberId: 'm1',
            },
        };
        const booked = wordsFor(
            entry({ kind: 'linked-meeting.booked', actor: { kind: 'sync', id: null }, properties: meeting }),
            names,
        );
        expect(booked).toMatchObject({ actor: 'Kate Morgan', family: 'meeting' });
        expect(booked.action).toMatch(/^booked “Acme intro” for /);
        const cancelled = wordsFor(
            entry({ kind: 'linked-meeting.cancelled', actor: { kind: 'sync', id: null }, properties: meeting }),
            names,
        );
        const viaSlotline = wordsFor(
            entry({
                kind: 'linked-meeting.booked',
                actor: { kind: 'sync', id: null },
                properties: { meeting: { ...meeting.meeting, bookedVia: 'slotline' } },
            }),
            names,
        );
        expect(viaSlotline.action).toMatch(/^booked “Acme intro” on Slotline for /);
        expect(cancelled).toMatchObject({
            actor: 'Kate Morgan',
            action: 'had “Acme intro” cancelled',
            family: 'meeting',
        });
    });
});
