import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/client';
import type { MailboxView } from '../../../api/types';
import { subjectToDoc } from '../templates/subject';
import {
    emptyVariables,
    emptyVariablesText,
    isBlank,
    ownSendingMailboxes,
    refusedVariables,
    sendInput,
    sendsAsTemplate,
    type Draft,
} from './compose';

const mailbox = (over: Partial<MailboxView>): MailboxView => ({
    id: 'mb-1',
    ownerMemberId: 'm-1',
    email: 'kate@example.com',
    label: null,
    purpose: 'personal',
    status: 'connected',
    grantedScopes: [],
    lastError: null,
    connectedAt: null,
    createdAt: '2026-10-09T08:00:00.000Z',
    updatedAt: '2026-10-09T08:00:00.000Z',
    ...over,
});

const doc = (...content: RichTextNode[]): RichText => ({ type: 'doc', content });
const para = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
const text = (t: string): RichTextNode => ({ type: 'text', text: t });
const chip = (path: string): RichTextNode => ({ type: 'variable', attrs: { path } });

describe('FR-CRMS-2: the mailboxes a member can send 1:1 mail from', () => {
    it('offers only their own personal, connected mailboxes — never a pool or another member’s', () => {
        const list = [
            mailbox({ id: 'mine' }),
            mailbox({ id: 'pool', purpose: 'pool' }),
            mailbox({ id: 'theirs', ownerMemberId: 'm-2' }),
            mailbox({ id: 'stopped', status: 'reconnect_needed' }),
            mailbox({ id: 'gone', status: 'disconnected' }),
        ];
        expect(ownSendingMailboxes(list, 'm-1').map((m) => m.id)).toEqual(['mine']);
        expect(ownSendingMailboxes(list, null)).toEqual([]);
    });
});

describe('FR-CRMS-3: empty variables hold the send', () => {
    const body = doc(para(text('Hi '), chip('person.firstName'), text(', about '), chip('custom.lastOutlet')));

    it('names the variables the draft uses that have no value, subject first', () => {
        const subject = subjectToDoc('Re {{company.name}}');
        expect(emptyVariables(subject, body, ['custom.lastOutlet', 'company.name', 'deal.name'])).toEqual([
            'company.name',
            'custom.lastOutlet',
        ]);
        expect(emptyVariables(subject, body, [])).toEqual([]);
    });

    it('says which are empty, for whom, and that Send is disabled', () => {
        expect(emptyVariablesText(['custom.lastOutlet'], 'Dana Reyes')).toBe(
            'custom.lastOutlet is empty for Dana Reyes · Send is disabled',
        );
        expect(emptyVariablesText(['a.b', 'c.d', 'e.f'], 'Dana')).toBe(
            'a.b, c.d and e.f are empty for Dana · Send is disabled',
        );
    });

    it('reads the variables a refused send named (422 unprocessable)', () => {
        const refused = new ApiError(422, 'unprocessable', 'no value', [
            { path: 'custom.lastOutlet', message: 'has no value' },
        ]);
        expect(refusedVariables(refused)).toEqual(['custom.lastOutlet']);
        expect(
            refusedVariables(new ApiError(400, 'validation.failed', 'bad', [{ path: 'sendAt', message: 'x' }])),
        ).toEqual([]);
    });

    it('treats an empty paragraph as nothing written, a chip as something', () => {
        expect(isBlank(doc(para()))).toBe(true);
        expect(isBlank(doc(para(text('  '))))).toBe(true);
        expect(isBlank(doc(para(chip('person.firstName'))))).toBe(false);
    });
});

describe('FR-CRMS-2: the request a draft sends', () => {
    const subject = subjectToDoc('Hello {{person.firstName}}');
    const body = doc(para(text('Hi')));
    const base: Draft = {
        mailboxId: 'mb-1',
        personId: 'p-1',
        alsoTo: [],
        subject,
        body,
        fill: null,
        timeZone: 'Europe/London',
    };

    it('sends written mail as subject and body, to the person by default', () => {
        expect(sendInput(base)).toEqual({
            mailboxId: 'mb-1',
            personId: 'p-1',
            subject: 'Hello {{person.firstName}}',
            body,
        });
    });

    it('sends a template left as filled as the template, and an edited one as written', () => {
        const fill = { templateId: 't-1', name: 'Follow-up', subject, body };
        expect(sendInput({ ...base, fill })).toEqual({ mailboxId: 'mb-1', personId: 'p-1', templateId: 't-1' });
        const edited = doc(para(text('Hi there')));
        expect(sendInput({ ...base, fill, body: edited })).toMatchObject({
            body: edited,
            subject: 'Hello {{person.firstName}}',
        });
        expect(sendInput({ ...base, fill, body: edited })).not.toHaveProperty('templateId');
    });

    it('lists the person first when others are added, and carries the deal, the reply and the schedule', () => {
        const at = new Date('2026-10-12T08:00:00.000Z');
        const input = sendInput({
            ...base,
            alsoTo: ['p-2'],
            dealId: 'd-1',
            replyToMessageId: 'msg-1',
            subject: doc(para()),
            sendAt: at,
        });
        expect(input).toEqual({
            mailboxId: 'mb-1',
            personId: 'p-1',
            dealId: 'd-1',
            to: [{ personId: 'p-1' }, { personId: 'p-2' }],
            body,
            replyToMessageId: 'msg-1',
            sendAt: '2026-10-12T08:00:00.000Z',
            timeZone: 'Europe/London',
        });
    });

    it('says when a filled template has been edited and will go as written', () => {
        const fill = { templateId: 't-1', name: 'Follow-up', subject, body };
        expect(sendsAsTemplate({ ...base, fill })).toBe(true);
        expect(sendsAsTemplate({ ...base, fill, subject: subjectToDoc('Changed') })).toBe(false);
        expect(sendsAsTemplate({ ...base, fill: null })).toBe(false);
    });

    it('never sends a reply as its template (the template’s subject would replace “Re:”)', () => {
        const fill = { templateId: 't-1', name: 'Follow-up', subject, body };
        expect(sendInput({ ...base, fill, replyToMessageId: 'msg-1' })).not.toHaveProperty('templateId');
    });
});
