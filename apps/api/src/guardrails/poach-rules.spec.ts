import { describe, expect, it } from 'vitest';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { syncedMembers, type SyncSource } from './mailbox-coverage';
import {
    isInternal,
    poachFindings,
    poachMessage,
    poachSeverity,
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
