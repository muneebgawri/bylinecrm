import { OFF_CRM_COLD_HIGH_RECIPIENTS, OFF_CRM_COLD_MEDIUM_RECIPIENTS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { syncedMembers, type SyncSource } from './mailbox-coverage';
import { effectiveOwner } from './guardrail-settings';
import {
    isCalendarMail,
    isInternal,
    offCrmColdFindings,
    offCrmColdMessage,
    offCrmColdSeverity,
    poachFindings,
    poachMessage,
    poachSeverity,
    type OffCrmColdFacts,
    type PoachFacts,
    type PoachRecipient,
} from './poach-rules';

const X = 'member-x';
const Y = 'member-y';
const recipient = (over: Partial<PoachRecipient> = {}): PoachRecipient => ({
    address: 'dana@acme.com',
    memberId: null,
    personId: 'person-1',
    companyId: 'company-1',
    ownerId: Y,
    exclusion: null,
    ...over,
});
const facts = (over: Partial<PoachFacts> = {}): PoachFacts => ({
    senderId: X,
    recipients: [recipient()],
    internalDomains: new Set(['byline.example']),
    threadMembers: new Set([X]),
    threadSenders: new Set(),
    ...over,
});

describe('GUARD-2 poaching rules', () => {
    it('flags mail to a lead another member owns', () => {
        expect(poachFindings(facts())).toEqual([
            { address: 'dana@acme.com', personId: 'person-1', companyId: 'company-1', ownerId: Y, exclusion: null },
        ]);
    });

    it('never flags the sender’s own lead, or a lead nobody owns', () => {
        expect(poachFindings(facts({ recipients: [recipient({ ownerId: X })] }))).toEqual([]);
        expect(poachFindings(facts({ recipients: [recipient({ ownerId: null })] }))).toEqual([]);
    });

    it('lets a reply through in a thread the owner is on (a cc’d colleague’s reply)', () => {
        expect(poachFindings(facts({ threadMembers: new Set([X, Y]) }))).toEqual([]);
    });

    it('ignores members and the workspace’s own domains, subdomains included', () => {
        const internal = [
            recipient({ address: 'ana@byline.example' }),
            recipient({ address: 'ops@eu.byline.example' }),
            recipient({ address: 'mia@elsewhere.com', memberId: Y }),
        ];
        expect(poachFindings(facts({ recipients: internal }))).toEqual([]);
        expect(isInternal('a@notbyline.example', new Set(['byline.example']))).toBe(false);
    });

    it('flags a customer on the exclusions nobody owns — unless the customer wrote in the thread first', () => {
        const customer = recipient({ ownerId: null, exclusion: { source: 'won_deal', reason: 'customer' } });
        expect(poachFindings(facts({ recipients: [customer] }))).toHaveLength(1);
        expect(poachFindings(facts({ recipients: [customer], threadSenders: new Set(['dana@acme.com']) }))).toEqual([]);
        // The customer's own account manager mailing them is not poaching.
        expect(poachFindings(facts({ recipients: [{ ...customer, ownerId: X }] }))).toEqual([]);
    });

    it('FR-CRMS-22: in one message to many, only another member’s leads are flagged — in order, lower-cased, nothing else', () => {
        const mixed = facts({
            recipients: [
                recipient({ address: 'Own@Mine.com', personId: 'p-own', companyId: null, ownerId: X }),
                recipient({ address: 'Dana@Acme.com' }),
                recipient({ address: 'ana@byline.example', personId: null, companyId: null, ownerId: null }),
                recipient({ address: 'mia@elsewhere.com', memberId: Y, ownerId: null }),
                recipient({ address: 'nobody@free.org', personId: 'p-none', companyId: null, ownerId: null }),
                recipient({ address: 'lee@other.com', personId: 'p-lee', companyId: 'company-2', ownerId: 'member-z' }),
            ],
        });
        expect(poachFindings(mixed)).toEqual([
            { address: 'dana@acme.com', personId: 'person-1', companyId: 'company-1', ownerId: Y, exclusion: null },
            {
                address: 'lee@other.com',
                personId: 'p-lee',
                companyId: 'company-2',
                ownerId: 'member-z',
                exclusion: null,
            },
        ]);
        // With one owner on the thread, only the other owner's lead is still flagged.
        expect(poachFindings({ ...mixed, threadMembers: new Set([X, Y]) }).map((f) => f.address)).toEqual([
            'lee@other.com',
        ]);
    });

    it('reports an address once however many roles it had', () => {
        expect(
            poachFindings(facts({ recipients: [recipient(), recipient({ address: 'DANA@acme.com' })] })),
        ).toHaveLength(1);
    });

    it('is medium for a first contact and high from the third distinct lead in the window', () => {
        expect(poachSeverity(1)).toBe('medium');
        expect(poachSeverity(2)).toBe('medium');
        expect(poachSeverity(3)).toBe('high');
    });

    it('says who, whom, when and the subject — nothing else', () => {
        expect(
            poachMessage({
                senderName: 'Xavier',
                senderAddress: 'x@byline.example',
                address: 'dana@acme.com',
                ownerName: 'Yasmin',
                exclusionSource: null,
                sentAt: new Date('2026-10-21T09:15:30Z'),
                subject: 'Quick intro',
            }),
        ).toBe('Xavier (x@byline.example) wrote to dana@acme.com, Yasmin’s lead, 2026-10-21 09:15 UTC: “Quick intro”');
    });
});

describe('GUARD-2 mailbox coverage sources', () => {
    const tx = {} as WorkspaceClient;
    it('credits each member to the first source that covers them, so #225 can add delegation after mailboxes', async () => {
        const mailbox: SyncSource = async () => new Set(['a']);
        const delegation: SyncSource = async (_tx, ids) => new Set(ids.filter((id) => id !== 'c'));
        const via = await syncedMembers(
            tx,
            ['a', 'b', 'c'],
            [
                ['mailbox', mailbox],
                ['delegation', delegation],
            ],
        );
        expect([...via]).toEqual([
            ['a', 'mailbox'],
            ['b', 'delegation'],
        ]);
    });
});

describe('GUARD-2 calendar mail', () => {
    it('knows a calendar’s own invitations and answers, in any case, and nothing else', () => {
        for (const subject of [
            'Invitation: Intro call @ Thu Oct 22, 2026 3pm - 3:30pm (PDT) (dana@acme.com)',
            'Updated invitation: Intro call @ Fri Oct 23, 2026',
            'Updated invitation with note: Intro call @ Fri Oct 23, 2026',
            'Invitation with note: Demo',
            'Accepted: Intro call @ Thu Oct 22, 2026',
            'Declined: Intro call',
            'Tentatively accepted: Intro call',
            'Canceled event: Intro call @ Thu Oct 22, 2026',
            'Cancelled event with note: Intro call',
            'Canceled: Weekly sync',
            'Tentative: Weekly sync',
            'New Time Proposed: Weekly sync',
            'INVITATION: Demo',
            '  updated event: Demo',
        ])
            expect(isCalendarMail(subject), subject).toBe(true);
        for (const subject of [
            'Quick intro',
            'Re: Invitation: Demo',
            'Your invitation to our webinar',
            'Accepted offer — next steps',
            '',
        ])
            expect(isCalendarMail(subject), subject).toBe(false);
    });
});

describe('GUARD-1/2 shared mailboxes', () => {
    it('reads a lead a shared mailbox owns as nobody’s; any other owner stands', () => {
        const shared = new Set(['outreach']);
        expect(effectiveOwner('outreach', shared)).toBeNull();
        expect(effectiveOwner(Y, shared)).toBe(Y);
        expect(effectiveOwner(null, shared)).toBeNull();
        expect(
            poachFindings(facts({ recipients: [recipient({ ownerId: effectiveOwner('outreach', shared) })] })),
        ).toEqual([]);
    });
});

describe('GUARD-3 cold mail outside the CRM', () => {
    const cold = (over: Partial<OffCrmColdFacts> = {}): OffCrmColdFacts => ({
        recipients: [
            recipient({ ownerId: X }),
            recipient({ address: 'eli@other.com', personId: null, companyId: null }),
        ],
        internalDomains: new Set(['byline.example']),
        threadSenders: new Set(),
        ...over,
    });

    it('flags every outside recipient of a first-touch mail, the sender’s own leads included', () => {
        expect(offCrmColdFindings(cold())).toEqual([
            { address: 'dana@acme.com', personId: 'person-1', companyId: 'company-1' },
            { address: 'eli@other.com', personId: null, companyId: null },
        ]);
    });

    it('flags nothing once someone outside wrote in the thread first (an answer, whatever the headers)', () => {
        expect(offCrmColdFindings(cold({ threadSenders: new Set(['dana@acme.com']) }))).toEqual([]);
        // A colleague writing first does not make it an answer.
        expect(offCrmColdFindings(cold({ threadSenders: new Set(['ana@byline.example']) }))).toHaveLength(2);
    });

    it('ignores members and the workspace’s own domains, and counts an address once', () => {
        const recipients = [
            recipient({ address: 'ana@byline.example' }),
            recipient({ address: 'mia@elsewhere.com', memberId: Y }),
            recipient({ address: 'Dana@acme.com' }),
            recipient({ address: 'dana@acme.com' }),
        ];
        expect(offCrmColdFindings(cold({ recipients }))).toHaveLength(1);
    });

    it('climbs the ladder by distinct outside addresses in the window', () => {
        expect(offCrmColdSeverity(1)).toBe('low');
        expect(offCrmColdSeverity(OFF_CRM_COLD_MEDIUM_RECIPIENTS)).toBe('medium');
        expect(offCrmColdSeverity(OFF_CRM_COLD_HIGH_RECIPIENTS)).toBe('high');
    });

    it('says who, whom, when, the subject and the count — never the body', () => {
        expect(
            offCrmColdMessage({
                senderName: 'Sam',
                senderAddress: 'sam@byline.example',
                address: 'dana@acme.com',
                recipientsInWindow: 4,
                sentAt: new Date('2026-11-08T09:30:00Z'),
                subject: ' Quick question ',
            }),
        ).toBe(
            'Sam (sam@byline.example) sent cold mail from Gmail, not the CRM, to dana@acme.com, 2026-11-08 09:30 UTC: “Quick question” — 4 outside addresses in 24 hours',
        );
    });
});
