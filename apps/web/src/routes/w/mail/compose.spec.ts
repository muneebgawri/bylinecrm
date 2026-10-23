import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/client';
import type { MailboxView } from '../../../api/types';
import { subjectToDoc } from '../templates/subject';
import {
    EMPTY_DOC,
    draftContent,
    followUpProblem,
    emptyVariables,
    emptyVariablesText,
    hasDraftContent,
    isBlank,
    ownSendingMailboxes,
    parseAddresses,
    placesSignature,
    refusedVariables,
    sendInput,
    sendsAsTemplate,
    stateFromDraft,
    withRecipient,
    type ComposerState,
    type Draft,
} from './compose';

const mailbox = (over: Partial<MailboxView>): MailboxView => ({
    id: 'mb-1',
    ownerMemberId: 'm-1',
    email: 'kate@example.com',
    label: null,
    purpose: 'personal',
    transport: 'gmail',
    credentialSource: 'oauth',
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
        // An image alone is something a reader sees.
        expect(isBlank(doc(para({ type: 'image', attrs: { src: 'https://x.test/a.png' } })))).toBe(false);
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

describe('#193 placesSignature', () => {
    const doc = (...content: object[]) => ({ type: 'doc', content }) as RichText;
    it('is whether the body names {{sender.signature}}, anywhere in it', () => {
        expect(placesSignature(doc({ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }))).toBe(false);
        expect(
            placesSignature(
                doc({
                    type: 'bulletList',
                    content: [
                        {
                            type: 'listItem',
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [{ type: 'variable', attrs: { path: 'sender.signature' } }],
                                },
                            ],
                        },
                    ],
                }),
            ),
        ).toBe(true);
    });
});

describe('queued follow-ups in the request', () => {
    const now = Date.parse('2026-10-20T09:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;
    const followUp = (days: number, body: RichText = doc(para(text('Nudge')))) => ({
        key: `f-${days}`,
        sendAt: new Date(now + days * DAY),
        subject: doc(para()),
        body,
    });
    const draft = (over: Partial<Draft> = {}): Draft => ({
        mailboxId: 'mb-1',
        personId: 'p-1',
        alsoTo: [],
        subject: subjectToDoc('Hello'),
        body: doc(para(text('Hi'))),
        fill: null,
        timeZone: 'Europe/London',
        ...over,
    });

    it('sends each follow-up’s time, body and only a subject of its own, with the sender’s zone', () => {
        const input = sendInput(
            draft({ followUps: [followUp(2), { ...followUp(4), subject: subjectToDoc('Still keen?') }] }),
        );
        expect(input.timeZone).toBe('Europe/London');
        expect(input.followUps).toEqual([
            { sendAt: new Date(now + 2 * DAY).toISOString(), body: doc(para(text('Nudge'))) },
            { sendAt: new Date(now + 4 * DAY).toISOString(), body: doc(para(text('Nudge'))), subject: 'Still keen?' },
        ]);
        expect(sendInput(draft())).not.toHaveProperty('followUps');
    });

    it('names the first follow-up that cannot go: no message, a bad time, or out of order', () => {
        expect(followUpProblem([followUp(2), followUp(4)], now, now)).toBeNull();
        expect(followUpProblem([followUp(2, doc(para()))], now, now)).toBe('Follow-up 1: write a message.');
        expect(followUpProblem([followUp(2), followUp(1)], now, now)).toBe(
            'Follow-up 2: pick a time after the email before it.',
        );
        expect(followUpProblem([followUp(2)], now + 3 * DAY, now)).toBe(
            'Follow-up 1: pick a time after the email before it.',
        );
        expect(followUpProblem([followUp(200)], now, now)).toMatch(/^Follow-up 1: pick a time within/);
    });

    it('reads a refused follow-up’s empty variable as the variable', () => {
        const refused = new ApiError(422, 'unprocessable', 'empty', [
            { path: 'followUps.0.person.city', message: 'has no value' },
        ]);
        expect(refusedVariables(refused)).toEqual(['person.city']);
    });
});

describe('cc and bcc', () => {
    it('reads typed or pasted addresses by the one address rule, and says which are not', () => {
        expect(parseAddresses(' Pat@Client.example, b@two.example;<c@three.example> nope ')).toEqual({
            addresses: ['pat@client.example', 'b@two.example', 'c@three.example'],
            invalid: ['nope'],
        });
        expect(parseAddresses('')).toEqual({ addresses: [], invalid: [] });
    });

    it('adds a recipient once, and sends people by id and addresses as typed', () => {
        const once = withRecipient(withRecipient([], { address: 'a@x.example' }), { address: 'a@x.example' });
        expect(once).toEqual([{ address: 'a@x.example' }]);
        const input = sendInput({
            mailboxId: 'mb-1',
            personId: 'p-1',
            alsoTo: [],
            cc: [{ personId: 'p-2', name: 'Sam' }, { address: 'a@x.example' }],
            bcc: [{ address: 'b@x.example' }],
            draftId: 'd-1',
            subject: subjectToDoc('Hi'),
            body: subjectToDoc('Hello'),
            fill: null,
            timeZone: 'UTC',
        });
        expect(input).toMatchObject({
            cc: [{ personId: 'p-2' }, { address: 'a@x.example' }],
            bcc: [{ address: 'b@x.example' }],
            draftId: 'd-1',
        });
        expect(input).not.toHaveProperty('to');
    });
});

describe('drafts', () => {
    const state = (over: Partial<ComposerState> = {}): ComposerState => ({
        mailboxId: 'mb-1',
        alsoTo: [],
        cc: [],
        bcc: [],
        subject: EMPTY_DOC,
        body: EMPTY_DOC,
        templateId: null,
        signature: undefined,
        sendAt: null,
        followUps: [],
        ...over,
    });

    it('an empty composer is nothing to keep; a subject, a recipient or a follow-up is', () => {
        expect(hasDraftContent(state())).toBe(false);
        expect(hasDraftContent(state({ subject: subjectToDoc('Hi') }))).toBe(true);
        expect(hasDraftContent(state({ cc: [{ address: 'a@x.example' }] }))).toBe(true);
    });

    it('keeps everything the composer holds, and puts it back as it was', () => {
        const at = new Date('2026-11-02T09:00:00.000Z');
        const held = state({
            alsoTo: [{ id: 'p-2', name: 'Sam Lee' }],
            cc: [{ personId: 'p-3', name: 'Ann' }, { address: 'a@x.example' }],
            bcc: [{ address: 'b@x.example' }],
            subject: subjectToDoc('About {{company.name}}'),
            body: subjectToDoc('Hello'),
            templateId: 't-1',
            signature: null,
            sendAt: at,
            followUps: [{ key: 'f', sendAt: null, subject: EMPTY_DOC, body: subjectToDoc('Nudge') }],
        });
        const content = draftContent('p-1', held, 'Europe/London');
        expect(content).toMatchObject({
            mailboxId: 'mb-1',
            to: [{ personId: 'p-1' }, { personId: 'p-2', name: 'Sam Lee' }],
            subject: 'About {{company.name}}',
            templateId: 't-1',
            signature: null,
            sendAt: at.toISOString(),
            timeZone: 'Europe/London',
            followUps: [{ sendAt: null, subject: '' }],
        });
        const back = stateFromDraft('p-1', { content: content as never });
        expect(back).toMatchObject({
            mailboxId: 'mb-1',
            alsoTo: [{ id: 'p-2', name: 'Sam Lee' }],
            cc: held.cc,
            bcc: held.bcc,
            templateId: 't-1',
            signature: null,
            sendAt: at,
        });
        expect(back.followUps).toHaveLength(1);
        expect(draftContent('p-1', back, 'Europe/London')).toEqual(content);
    });
});
