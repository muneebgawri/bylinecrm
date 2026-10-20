import { isNegativeReply } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { fingerprint, hamming, normaliseBody, normaliseSubject, simhash } from './fingerprint';
import {
    largestNearDuplicate,
    largestSubject,
    nearDuplicateRecipients,
    recipientsSince,
    type WindowEntry,
} from './judge';

const template = (name: string, n: number) =>
    `Hi ${name},\n\nI noticed your team at Acme is growing fast and wanted to share how we helped ${n} companies cut their onboarding time in half with a short pilot. Would you be open to a 15 minute call next week to see if it fits? https://example.com/t/${n}\n\nBest,\nSam\n-- \nSam Seller | +1 555 0100`;

describe('REP-1 fingerprint (FR-CRMS-23)', () => {
    it('drops greeting, signature, quoted text, URLs and numbers', () => {
        const body = normaliseBody('Hello Dana,\nPrice is 42 at https://x.test/a?b=1\n> old quote\nThanks,\nSam');
        expect(body).toBe('price is at');
        expect(normaliseBody('Hi\nNew text\nOn Mon, 1 Jan 2026, Bo wrote:\n> earlier')).toBe('new text');
    });

    it('normalises a subject: prefixes, numbers and case', () => {
        expect(normaliseSubject('Re: RE: Fwd: Q3 pricing #42')).toBe('q pricing');
        expect(normaliseSubject('')).toBe('');
    });

    it('templated messages land within 3 bits; unrelated ones do not', () => {
        const a = fingerprint('Quick question', template('Dana', 120)).simhash!;
        const b = fingerprint('Quick question', template('Bo', 340)).simhash!;
        const c = fingerprint('Invoice', 'Attached is the signed contract for the warehouse lease renewal.').simhash!;
        expect(hamming(a, b)).toBeLessThanOrEqual(3);
        expect(hamming(a, c)).toBeGreaterThan(10);
    });

    it('an empty body has no simhash and never matches', () => {
        expect(simhash('')).toBeNull();
        expect(
            nearDuplicateRecipients(
                [{ addresses: ['a@x.test'], simhash: null, subjectKey: '', at: new Date() }],
                null,
                3,
            ).size,
        ).toBe(0);
    });

    it('fits a signed 64-bit integer', () => {
        const h = simhash('one two three four five')!;
        expect(h >= -(1n << 63n) && h < 1n << 63n).toBe(true);
    });
});

describe('REP-1 judgement (FR-CRMS-23)', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const entry = (to: string, body: string, subject: string, minutesAgo = 10): WindowEntry => {
        const f = fingerprint(subject, body);
        return {
            addresses: [to],
            simhash: f.simhash,
            subjectKey: f.subjectKey,
            at: new Date(now.getTime() - minutesAgo * 60_000),
        };
    };

    it('counts distinct recipients in a window', () => {
        const entries = [
            entry('a@x.test', 'x', 's', 10),
            entry('a@x.test', 'y', 's', 20),
            entry('b@x.test', 'z', 's', 120),
        ];
        expect(recipientsSince(entries, new Date(now.getTime() - 3_600_000)).size).toBe(1);
        expect(recipientsSince(entries, new Date(now.getTime() - 86_400_000)).size).toBe(2);
    });

    it('finds the largest near-identical group and repeated subject', () => {
        const entries = [
            ...Array.from({ length: 10 }, (_, i) => entry(`p${i}@x.test`, template(`P${i}`, i), `Intro ${i}`)),
            entry('other@x.test', 'Totally different note about lunch on Friday.', 'Lunch'),
        ];
        expect(largestNearDuplicate(entries, 3).recipients).toBe(10);
        expect(largestSubject(entries)).toEqual({ recipients: 10, subjectKey: 'intro' });
    });

    it('recognises negative replies', () => {
        expect(isNegativeReply(normaliseBody('Please remove me from your list.'))).toBe(true);
        expect(isNegativeReply(normaliseBody('Sounds good, Tuesday works.'))).toBe(false);
    });
});
