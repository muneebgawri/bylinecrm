import { describe, expect, it } from 'vitest';
import { evaluateDomain } from './domain-checks';

const records = (entries: Record<string, string[]>) => (name: string) => entries[name] ?? [];

describe('FR-CRMS-13 sending-domain DNS checks (P3-2)', () => {
    const good = {
        'out.example': ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc'],
        'google._domainkey.out.example': ['v=DKIM1; k=rsa; p=MIIBIjANBgkqh'],
        '_dmarc.out.example': ['v=DMARC1; p=none; rua=mailto:dmarc@out.example'],
    };

    it('passes a domain with Google SPF, a DKIM key at the selector and a DMARC record', () => {
        const check = evaluateDomain('out.example', 'google', records(good));
        expect(check.spf.outcome).toBe('pass');
        expect(check.dkim.outcome).toBe('pass');
        expect(check.dmarc.outcome).toBe('pass');
    });

    it('fails SPF that does not include Google, or two SPF records', () => {
        expect(
            evaluateDomain(
                'out.example',
                'google',
                records({ ...good, 'out.example': ['v=spf1 include:mailgun.org ~all'] }),
            ).spf,
        ).toMatchObject({ outcome: 'fail', message: expect.stringContaining('_spf.google.com') });
        expect(
            evaluateDomain(
                'out.example',
                'google',
                records({ ...good, 'out.example': ['v=spf1 include:_spf.google.com ~all', 'v=spf1 -all'] }),
            ).spf,
        ).toMatchObject({ outcome: 'fail', message: expect.stringContaining('more than one') });
    });

    it('fails a missing or revoked (empty p=) DKIM key, naming the selector looked up', () => {
        expect(
            evaluateDomain('out.example', 'google', records({ ...good, 'google._domainkey.out.example': [] })).dkim,
        ).toMatchObject({
            outcome: 'fail',
            message: expect.stringContaining('google._domainkey.out.example'),
        });
        expect(
            evaluateDomain(
                'out.example',
                'google',
                records({ ...good, 'google._domainkey.out.example': ['v=DKIM1; p='] }),
            ).dkim.outcome,
        ).toBe('fail');
    });

    it('fails a missing DMARC record, or one without a policy', () => {
        expect(
            evaluateDomain('out.example', 'google', records({ ...good, '_dmarc.out.example': [] })).dmarc.outcome,
        ).toBe('fail');
        expect(
            evaluateDomain(
                'out.example',
                'google',
                records({ ...good, '_dmarc.out.example': ['v=DMARC1; rua=mailto:x@y'] }),
            ).dmarc.outcome,
        ).toBe('fail');
    });
});
