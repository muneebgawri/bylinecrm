import { describe, expect, it } from 'vitest';
import type { PoachRecipient } from '../guardrails/poach-rules';
import { relayBlockedMessage, relayBounceText, relayRefusals, type RelayFacts } from './relay-rules';

const ana = 'member-ana';
const ben = 'member-ben';
const internal = new Set(['pinion.test']);

function recipient(address: string, extra: Partial<PoachRecipient> = {}): PoachRecipient {
    return { address, memberId: null, personId: null, companyId: null, ownerId: null, exclusion: null, ...extra };
}

function facts(recipients: PoachRecipient[], extra: Partial<RelayFacts> = {}): RelayFacts {
    return {
        senderId: ana,
        recipients,
        internalDomains: internal,
        threadMembers: new Set(),
        threadSenders: new Set(),
        ...extra,
    };
}

describe('relayRefusals', () => {
    it('lets own leads, colleagues and the workspace domains through', () => {
        expect(
            relayRefusals(
                facts([
                    recipient('lee@lead.test', { personId: 'p1', ownerId: ana }),
                    recipient('ben@pinion.test', { memberId: ben }),
                    recipient('hr@pinion.test'),
                    recipient('co@corp.test', { companyId: 'c1', ownerId: ana }),
                ]),
            ),
        ).toEqual([]);
    });

    it("bounces another member's lead as poaching and a stranger as cold mail, once per address", () => {
        const refusals = relayRefusals(
            facts([
                recipient('bo@bo.test', { personId: 'p2', ownerId: ben }),
                recipient('BO@bo.test', { personId: 'p2', ownerId: ben }),
                recipient('new@stranger.test'),
            ]),
        );
        expect(refusals.map((r) => [r.address, r.kind, r.ownerId])).toEqual([
            ['bo@bo.test', 'poach_suspected', ben],
            ['new@stranger.test', 'off_crm_cold', null],
        ]);
    });

    it('is an answer, not cold, once someone outside wrote in the thread — but still poaching', () => {
        const thread = { threadSenders: new Set(['new@stranger.test']) };
        expect(relayRefusals(facts([recipient('new@stranger.test')], thread))).toEqual([]);
        expect(
            relayRefusals(
                facts([recipient('bo@bo.test', { ownerId: ben }), recipient('new@stranger.test')], thread),
            ).map((r) => r.kind),
        ).toEqual(['poach_suspected']);
    });

    it("lets a reply through when the lead's owner is on the thread", () => {
        expect(
            relayRefusals(facts([recipient('bo@bo.test', { ownerId: ben })], { threadMembers: new Set([ben]) })),
        ).toEqual([]);
    });

    it('bounces a customer on the exclusions nobody owns, unless they wrote first', () => {
        const customer = recipient('cy@cust.test', { exclusion: { source: 'customers', reason: 'paid' } });
        expect(relayRefusals(facts([customer])).map((r) => r.kind)).toEqual(['poach_suspected']);
        expect(relayRefusals(facts([customer], { threadSenders: new Set(['cy@cust.test']) }))).toEqual([]);
    });
});

describe('bounce and event text', () => {
    const owners = new Map([[ben, 'Ben']]);
    const refusals = relayRefusals(
        facts([
            recipient('bo@bo.test', { ownerId: ben }),
            recipient('new@stranger.test'),
            recipient('cy@cust.test', { exclusion: { source: 'customers', reason: 'paid' } }),
        ]),
    );

    it('names each address and what to do', () => {
        expect(relayBounceText(refusals, owners, 'https://crm.test')).toBe(
            [
                'Byline CRM did not send this email.',
                "bo@bo.test: Ben's lead — ask them, or send from Byline CRM.",
                'cy@cust.test: a customer (customers) — send from Byline CRM.',
                'new@stranger.test: not one of your contacts — cold outreach is sent from Byline CRM, not Gmail.',
                'Open the contact in https://crm.test and send from there. Replies to people who wrote to you are not affected.',
            ].join('\n'),
        );
    });

    it('says who, whom, when and the subject, never the body', () => {
        const at = new Date('2026-11-11T18:00:00Z');
        expect(
            relayBlockedMessage({
                senderName: 'Ana',
                senderAddress: 'ana@pinion.test',
                refusal: refusals[0]!,
                ownerName: 'Ben',
                subject: ' Hi ',
                at,
            }),
        ).toBe(
            'Ana (ana@pinion.test) tried to send bo@bo.test Ben’s lead from Gmail; the relay bounced it, 2026-11-11 18:00 UTC: “Hi”',
        );
        expect(
            relayBlockedMessage({
                senderName: 'Ana',
                senderAddress: 'ana@pinion.test',
                refusal: refusals[2]!,
                ownerName: null,
                subject: '',
                at,
            }),
        ).toContain('cold mail from Gmail; the relay bounced it, 2026-11-11 18:00 UTC: (no subject)');
    });
});
