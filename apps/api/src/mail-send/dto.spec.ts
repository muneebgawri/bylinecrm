import { MAIL_FOLLOW_UPS_MAX, MAIL_SEND_RECIPIENTS_MAX } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { CreateMailDraftDto, SaveMailDraftDto, SendMailDto } from './dto';

const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };
const base = {
    mailboxId: '00000000-0000-4000-8000-000000000001',
    personId: '00000000-0000-4000-8000-000000000002',
    subject: 'Hello',
    body,
};
const at = (hours: number) => new Date(Date.UTC(2030, 0, 1) + hours * 3_600_000).toISOString();
const paths = (input: unknown) => {
    const result = SendMailDto.schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('SendMailDto follow-ups', () => {
    it('takes follow-ups each later than the one before, a body or a template each', () => {
        expect(
            paths({
                ...base,
                sendAt: at(0),
                followUps: [
                    { sendAt: at(24), body },
                    { sendAt: at(48), subject: 'Still keen?', body },
                    { sendAt: at(72), templateId: '00000000-0000-4000-8000-000000000003' },
                ],
            }),
        ).toEqual([]);
    });

    it('refuses a follow-up not later than the email before it, naming it', () => {
        expect(paths({ ...base, sendAt: at(10), followUps: [{ sendAt: at(10), body }] })).toEqual([
            'followUps.0.sendAt',
        ]);
        expect(
            paths({
                ...base,
                followUps: [
                    { sendAt: at(24), body },
                    { sendAt: at(12), body },
                ],
            }),
        ).toEqual(['followUps.1.sendAt']);
    });

    it('refuses a follow-up with neither a body nor a template, or both', () => {
        expect(paths({ ...base, followUps: [{ sendAt: at(24) }] })).toEqual(['followUps.0.body']);
        expect(
            paths({
                ...base,
                followUps: [{ sendAt: at(24), body, templateId: '00000000-0000-4000-8000-000000000003' }],
            }),
        ).toEqual(['followUps.0.body']);
    });

    it(`refuses more than ${MAIL_FOLLOW_UPS_MAX} follow-ups, and anything a follow-up does not take`, () => {
        const many = Array.from({ length: MAIL_FOLLOW_UPS_MAX + 1 }, (_, i) => ({ sendAt: at(24 * (i + 1)), body }));
        expect(paths({ ...base, followUps: many })).toEqual(['followUps']);
        expect(paths({ ...base, followUps: [{ sendAt: at(24), body, to: [] }] })).toEqual(['followUps.0']);
    });
});

describe('SendMailDto cc and bcc', () => {
    it('takes any address, or a person, in cc and bcc — and the draft the message was written in', () => {
        expect(
            paths({
                ...base,
                cc: [{ address: 'pat@client.example' }, { personId: '00000000-0000-4000-8000-000000000004' }],
                bcc: [{ address: 'me@agency.example' }],
                draftId: '00000000-0000-4000-8000-000000000005',
            }),
        ).toEqual([]);
    });

    it('refuses an address that is not one, and more recipients than one message takes', () => {
        expect(paths({ ...base, cc: [{ address: 'not an address' }] })).toEqual(['cc.0.address']);
        const many = Array.from({ length: MAIL_SEND_RECIPIENTS_MAX + 1 }, (_, i) => ({ address: `p${i}@x.example` }));
        expect(paths({ ...base, bcc: many })).toEqual(['bcc']);
    });
});

describe('a draft’s content', () => {
    const draft = (content: unknown) => {
        const result = CreateMailDraftDto.schema.safeParse({ personId: base.personId, content });
        return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    };

    it('may be unfinished: no subject, no body, a follow-up with no time yet', () => {
        expect(draft({})).toEqual([]);
        expect(
            draft({
                to: [{ personId: base.personId, name: 'Dana Reyes' }],
                cc: [{ address: 'pat@client.example' }],
                subject: '',
                followUps: [{ sendAt: null, body }],
                sendAt: null,
            }),
        ).toEqual([]);
    });

    it('is checked for shape and size: an address, at most as many follow-ups as a send, nothing else', () => {
        expect(draft({ cc: [{ address: 'nope' }] })).toEqual(['content.cc.0.address']);
        const many = Array.from({ length: MAIL_FOLLOW_UPS_MAX + 1 }, () => ({ body }));
        expect(draft({ followUps: many })).toEqual(['content.followUps']);
        expect(draft({ attachments: [] })).toEqual(['content']);
    });

    it('a reply’s draft names the message it answers, by id', () => {
        const reply = (replyToMessageId: unknown) =>
            CreateMailDraftDto.schema.safeParse({ personId: base.personId, replyToMessageId, content: {} }).success;
        expect(reply('00000000-0000-4000-8000-000000000009')).toBe(true);
        expect(reply('msg-1')).toBe(false);
    });

    it('a save names the version it replaces', () => {
        expect(SaveMailDraftDto.schema.safeParse({ content: {} }).success).toBe(false);
        expect(SaveMailDraftDto.schema.safeParse({ version: 2, content: {} }).success).toBe(true);
    });
});
