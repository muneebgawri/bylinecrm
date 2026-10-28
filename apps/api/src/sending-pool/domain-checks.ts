import type { DomainCheck, DomainCheckStep } from '@bylinecrm/shared';
import { SMTP2GO_SPF_INCLUDE } from '../smtp2go/smtp2go.constants';
import { GOOGLE_SPF_INCLUDE } from './sending-pool.constants';

/**
 * The DKIM selectors a domain's check reads (TRANS-1): the primary (Gmail's, `google`) while a Gmail-transport
 * mailbox sends from the domain — or when no other selector is known — and every other selector its senders
 * sign with (each SMTP2Go mailbox's).
 */
export function dkimSelectorsToCheck(
    row: { dkimSelector: string; extraDkimSelectors: readonly string[] },
    gmailSends: boolean,
): string[] {
    const primary = gmailSends || row.extraDkimSelectors.length === 0 ? [row.dkimSelector] : [];
    return [...new Set([...primary, ...row.extraDkimSelectors])];
}

/** The names a sending domain's check reads: one DKIM name per selector. */
export function domainCheckNames(
    domain: string,
    selectors: readonly string[],
): { spf: string; dkim: string[]; dmarc: string } {
    return { spf: domain, dkim: selectors.map((s) => `${s}._domainkey.${domain}`), dmarc: `_dmarc.${domain}` };
}

/** A TXT lookup's answer: the records, or why it could not be made ("could not check" is never "passed"). */
export type TxtAnswer = string[] | { failure: string };

const pass = (message: string): DomainCheckStep => ({ outcome: 'pass', message });
const fail = (message: string): DomainCheckStep => ({ outcome: 'fail', message });

/**
 * Whether a sending domain passes SPF, DKIM and DMARC (FR-CRMS-13), from its TXT records — a pure
 * judgement, so the lookups happen elsewhere, outside any transaction. DKIM passes only when every
 * selector checked has a key. What each step requires and why: docs/design-notes/P3-2.md.
 */
export function evaluateDomain(
    domain: string,
    selectors: readonly string[],
    txt: (name: string) => TxtAnswer,
): DomainCheck {
    const names = domainCheckNames(domain, selectors);
    const step = (name: string, judge: (records: string[]) => DomainCheckStep): DomainCheckStep => {
        const answer = txt(name);
        return Array.isArray(answer) ? judge(answer) : fail(answer.failure);
    };
    const dkim = names.dkim.map((name) => step(name, (records) => dkimStep(name, records)));
    const dkimFails = dkim.filter((s) => s.outcome === 'fail');
    return {
        spf: step(names.spf, spfStep),
        dkim:
            dkimFails.length > 0
                ? fail(dkimFails.map((s) => s.message).join('; '))
                : dkim.length === 1
                  ? dkim[0]!
                  : pass(`DKIM keys found at ${names.dkim.join(', ')}`),
        dmarc: step(names.dmarc, (records) => dmarcStep(names.dmarc, records)),
    };
}

function spfStep(records: string[]): DomainCheckStep {
    const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    if (spf.length === 0) return fail(`no SPF record (v=spf1); add one that includes ${GOOGLE_SPF_INCLUDE}`);
    if (spf.length > 1)
        return fail('more than one SPF record; receivers treat that as no SPF at all — merge them into one');
    const terms = spf[0]!.split(/\s+/).map((term) => term.toLowerCase());
    if (terms.includes(`include:${GOOGLE_SPF_INCLUDE}`)) return pass(`SPF includes ${GOOGLE_SPF_INCLUDE}`);
    // A domain the pool sends from through SMTP2Go (TRANS-1) names SMTP2Go's servers instead.
    if (terms.includes(`include:${SMTP2GO_SPF_INCLUDE}`)) return pass(`SPF includes ${SMTP2GO_SPF_INCLUDE} (SMTP2Go)`);
    return fail(
        `the SPF record does not include ${GOOGLE_SPF_INCLUDE}, so Gmail's servers are not allowed to send for the domain (or ${SMTP2GO_SPF_INCLUDE}, for SMTP2Go)`,
    );
}

function dkimStep(name: string, records: string[]): DomainCheckStep {
    const key = records.find((r) => /(^|;)\s*p=/i.test(r));
    if (!key)
        return fail(
            `no DKIM key at ${name}; turn on DKIM for the domain in Google Workspace (or SMTP2Go) with that selector`,
        );
    const value = /(?:^|;)\s*p=([^;]*)/i.exec(key)?.[1]?.trim() ?? '';
    return value ? pass(`DKIM key found at ${name}`) : fail(`the DKIM key at ${name} is empty (revoked)`);
}

function dmarcStep(name: string, records: string[]): DomainCheckStep {
    const dmarc = records.filter((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
    if (dmarc.length === 0) return fail(`no DMARC record at ${name}`);
    if (dmarc.length > 1) return fail(`more than one DMARC record at ${name}`);
    const policy = /(?:^|;)\s*p=\s*(none|quarantine|reject)\s*(;|$)/i.exec(dmarc[0]!)?.[1];
    return policy
        ? pass(`DMARC policy ${policy.toLowerCase()}`)
        : fail(`the DMARC record at ${name} has no policy (p=)`);
}
