import { describe, expect, it } from 'vitest';
import { FakeDns } from '../../test/support/fake-dns';
import { FREE_VERIFIER_SOURCE } from '@bylinecrm/shared';
import { FreeVerifier } from './free-verifier';

/**
 * The free verifier (P3-5, FR-CRMS-14) behind the `Verifier` port (FR-CRMS-16) against the in-memory DNS: one MX lookup per address with a
 * well-formed domain, none for a syntax failure, `unknown` when DNS cannot answer, and no SMTP probe.
 */
describe('FR-CRMS-14 the free verifier', () => {
    it('FR-CRMS-16: implements the Verifier port, names its source, and asks DNS for the domain’s MX once per address', async () => {
        const dns = new FakeDns();
        dns.setMx('example.com', 'mx1.example.com', 'mx2.example.com');
        const verifier = new FreeVerifier(dns);
        expect(verifier.source).toBe(FREE_VERIFIER_SOURCE);
        expect(await verifier.verify('Jane@Example.com')).toMatchObject({
            result: 'valid',
            reason: 'deliverable',
            source: FREE_VERIFIER_SOURCE,
        });
        expect(dns.mxLookups).toEqual(['example.com']);
    });

    it('does not ask DNS about an address whose syntax already fails', async () => {
        const dns = new FakeDns();
        expect(await new FreeVerifier(dns).verify('nobody')).toMatchObject({ result: 'invalid', reason: 'syntax' });
        expect(dns.mxLookups).toEqual([]);
    });

    it('#165 FR-CRMS-14: reads no such domain, no mail server, a null MX and a disposable domain as invalid, and a role address as risky', async () => {
        const dns = new FakeDns();
        dns.setMx('web.example');
        dns.setMx('nomail.example', '.');
        dns.setMx('mailinator.com', 'mx.mailinator.com');
        const verifier = new FreeVerifier(dns);
        expect(await verifier.verify('jane@gone.example')).toMatchObject({ result: 'invalid', reason: 'no_domain' });
        expect(await verifier.verify('jane@web.example')).toMatchObject({
            result: 'invalid',
            reason: 'no_mail_server',
        });
        expect(await verifier.verify('jane@nomail.example')).toMatchObject({ result: 'invalid', reason: 'null_mx' });
        expect(await verifier.verify('jane@mailinator.com')).toMatchObject({ result: 'invalid', reason: 'disposable' });
        dns.setMx('example.com', 'mx.example.com');
        expect(await verifier.verify('sales@example.com')).toMatchObject({ result: 'risky', reason: 'role' });
    });

    it('answers unknown, never valid, when the lookup fails', async () => {
        const dns = new FakeDns();
        dns.setMx('example.com', 'mx.example.com');
        dns.failMx('example.com');
        expect(await new FreeVerifier(dns).verify('jane@example.com')).toMatchObject({
            result: 'unknown',
            reason: 'lookup_failed',
            message: expect.stringContaining('example.com'),
        });
    });
});
