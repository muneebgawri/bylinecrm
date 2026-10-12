import { describe, expect, it } from 'vitest';
import { isDisposableDomain, isRoleAddress, judgeAddress, parseAddress } from './address-checks';

/**
 * The free verification layer's pure judgements (P3-5, FR-CRMS-14): syntax, role-address and
 * disposable-domain detection, and the verdict from a domain's MX lookup. No network here — the
 * lookup's answer is handed in, as `FreeVerifier` does after asking DNS outside any transaction.
 */
describe('FR-CRMS-14 address checks', () => {
    describe('syntax', () => {
        it('accepts a dot-atom local part at a dotted host name and normalises the domain to lower case', () => {
            expect(parseAddress('  Jane.Doe+news@Example.COM ')).toEqual({
                address: 'jane.doe+news@example.com',
                local: 'Jane.Doe+news',
                domain: 'example.com',
            });
            expect(parseAddress("o'brien@sub.example.co.uk")?.domain).toBe('sub.example.co.uk');
        });

        it('refuses what is not an address: no @, no dot in the domain, a bad label, a numeric TLD, spaces, quotes', () => {
            for (const bad of [
                '',
                'jane',
                'jane@',
                '@example.com',
                'jane@localhost',
                'jane@example',
                'jane@-example.com',
                'jane@example-.com',
                'jane@example.c0m',
                'jane doe@example.com',
                '"jane doe"@example.com',
                'jane@@example.com',
                'jane@exa mple.com',
                '.jane@example.com',
                'jane.@example.com',
                'ja..ne@example.com',
                `${'a'.repeat(65)}@example.com`,
            ]) {
                expect(parseAddress(bad), bad).toBeNull();
            }
        });

        it('accepts an internationalised domain by its ASCII form', () => {
            expect(parseAddress('jane@bücher.example')?.domain).toBe('xn--bcher-kva.example');
        });
    });

    it('knows a role address by its local part, whatever the case', () => {
        for (const role of ['info', 'Sales', 'NOREPLY', 'no-reply', 'postmaster', 'press', 'hello']) {
            expect(isRoleAddress(role), role).toBe(true);
        }
        for (const person of ['jane', 'jane.doe', 'jdoe2', 'information', 'salesforce']) {
            expect(isRoleAddress(person), person).toBe(false);
        }
    });

    it('knows a disposable domain from the maintained list, not its look-alikes', () => {
        expect(isDisposableDomain('mailinator.com')).toBe(true);
        expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
        expect(isDisposableDomain('example.com')).toBe(false);
        expect(isDisposableDomain('mailinator.example')).toBe(false);
    });

    describe('the verdict', () => {
        const found = { status: 'found' as const, exchanges: ['mx.example.com'] };

        it('is invalid for bad syntax, a domain that does not exist, one with no mail server, and a null MX', () => {
            expect(judgeAddress('not an address', found)).toMatchObject({ result: 'invalid', reason: 'syntax' });
            expect(judgeAddress('jane@gone.example', { status: 'no_domain' })).toMatchObject({
                result: 'invalid',
                reason: 'no_domain',
                message: expect.stringContaining('gone.example'),
            });
            expect(judgeAddress('jane@web.example', { status: 'no_records' })).toMatchObject({
                result: 'invalid',
                reason: 'no_mail_server',
            });
            expect(judgeAddress('jane@nomail.example', { status: 'found', exchanges: ['.'] })).toMatchObject({
                result: 'invalid',
                reason: 'null_mx',
            });
        });

        it('is risky for a disposable domain and for a role address — deliverable, but not to a person', () => {
            expect(judgeAddress('jane@mailinator.com', found)).toMatchObject({ result: 'risky', reason: 'disposable' });
            expect(judgeAddress('info@example.com', found)).toMatchObject({
                result: 'risky',
                reason: 'role',
                message: expect.stringContaining('info@'),
            });
        });

        it('is unknown — never valid — when the lookup failed', () => {
            expect(judgeAddress('jane@example.com', 'failed')).toMatchObject({
                result: 'unknown',
                reason: 'lookup_failed',
            });
        });

        it('is valid when the syntax holds, the domain has a mail server, and the address is neither disposable nor a role', () => {
            expect(judgeAddress('Jane@Example.com', found)).toEqual({
                result: 'valid',
                reason: 'deliverable',
                message: expect.stringContaining('example.com'),
            });
        });

        it('judges the domain, not the whole address, as disposable: a disposable domain with no mail server is invalid first', () => {
            expect(judgeAddress('jane@mailinator.com', { status: 'no_records' })).toMatchObject({ result: 'invalid' });
        });
    });
});
