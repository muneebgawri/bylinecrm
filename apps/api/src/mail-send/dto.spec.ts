import { MAIL_FOLLOW_UPS_MAX } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { SendMailDto } from './dto';

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
