import { describe, expect, it } from 'vitest';
import { e164Of, phoneTail } from '@bylinecrm/shared';
import { directionOf, outsideNumber, ownNumber, phonesPattern, statusOf } from './call-rules';
import { readEnvelope } from './quo-hook.service';
import type { QuoCall } from './quo.port';

const call = (over: Partial<QuoCall> = {}): QuoCall => ({
    id: 'AC1',
    direction: 'outgoing',
    status: 'completed',
    phoneNumberId: 'PN1',
    actorId: 'US1',
    participants: [
        { phoneNumber: '+14155550100', actorId: 'US1' },
        { phoneNumber: '+447700900123', actorId: null },
    ],
    createdAt: '2026-11-09T10:00:00Z',
    answeredAt: '2026-11-09T10:00:05Z',
    completedAt: '2026-11-09T10:03:00Z',
    duration: 175,
    summary: null,
    voicemail: null,
    ...over,
});

describe('CALL-1 call rules', () => {
    it('tells the outside number from the member’s own', () => {
        expect(outsideNumber(call())).toBe('+447700900123');
        expect(ownNumber(call())).toBe('+14155550100');
        expect(directionOf(call())).toBe('outbound');
        expect(directionOf(call({ direction: 'incoming' }))).toBe('inbound');
    });

    it('reads Quo’s statuses as answered, missed, voicemail or unanswered', () => {
        expect(statusOf(call())).toBe('answered');
        expect(statusOf(call({ status: 'missed', answeredAt: null }))).toBe('missed');
        expect(statusOf(call({ status: 'no-answer', answeredAt: null }))).toBe('missed');
        expect(statusOf(call({ status: 'completed', answeredAt: null }))).toBe('unanswered');
        expect(
            statusOf(
                call({
                    status: 'completed',
                    answeredAt: null,
                    voicemail: { recordingUrl: 'https://r/x.mp3', duration: 20 },
                }),
            ),
        ).toBe('voicemail');
    });

    it('matches a person’s stored phones by the number’s last nine digits, trunk prefix or not', () => {
        expect(phonesPattern('+447700900123')).toBe('"number":\\s*"[0-9]*700900123"');
        expect('"number": "07700900123"').toMatch(new RegExp(phonesPattern('+447700900123')!));
        expect('"number":"07700900123"').toMatch(new RegExp(phonesPattern('+447700900123')!));
        expect('"number":"7700900123"').toMatch(new RegExp(phonesPattern('+447700900123')!));
        expect('"number":"7700900124"').not.toMatch(new RegExp(phonesPattern('+447700900123')!));
        expect(phonesPattern('+1555')).toBeNull();
        expect(phoneTail('+1 (415) 555-0100')).toBe('155550100');
    });

    it('dials a person’s phone in E.164, dropping a trunk zero outside North America', () => {
        expect(e164Of({ number: '4155550100', countryCode: 'US' })).toBe('+14155550100');
        expect(e164Of({ number: '07700900123', countryCode: 'GB' })).toBe('+447700900123');
        expect(e164Of({ number: '3001234567', countryCode: 'PK' })).toBe('+923001234567');
        expect(e164Of({ number: '123', countryCode: 'ZZ' })).toBeNull();
        expect(e164Of(null)).toBeNull();
    });

    it('reads which call a delivery is about: the resource for call events, callId for what follows one', () => {
        expect(readEnvelope({ type: 'call.completed', data: { resource: { id: 'AC9' } } })).toEqual({
            type: 'call.completed',
            callId: 'AC9',
        });
        expect(
            readEnvelope({ type: 'call.summary.completed', data: { resource: { callId: 'AC9', summary: [] } } }),
        ).toEqual({ type: 'call.summary.completed', callId: 'AC9' });
        expect(readEnvelope({ type: 'message.received', data: { resource: { id: 'AC-not' } } })?.callId).toBe('AC-not');
        expect(readEnvelope({ type: 'contact.updated', data: { resource: { id: 'CT1' } } })).toEqual({
            type: 'contact.updated',
            callId: null,
        });
        expect(readEnvelope('nope')).toBeNull();
    });
});
