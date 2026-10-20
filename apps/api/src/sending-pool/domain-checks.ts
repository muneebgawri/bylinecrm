import type { DomainCheck, DomainCheckStep } from '@bylinecrm/shared';
import { SMTP2GO_SPF_INCLUDE } from '../smtp2go/smtp2go.constants';
import { GOOGLE_SPF_INCLUDE } from './sending-pool.constants';

/** The three names a sending domain's check reads. */
export function domainCheckNames(domain: string, selector: string): { spf: string; dkim: string; dmarc: string } {
    return { spf: domain, dkim: `${selector}._domainkey.${domain}`, dmarc: `_dmarc.${domain}` };
}

const pass = (message: string): DomainCheckStep => ({ outcome: 'pass', message });
const fail = (message: string): DomainCheckStep => ({ outcome: 'fail', message });

/**
 * Whether a sending domain passes SPF, DKIM and DMARC (FR-CRMS-13), from its TXT records — a pure
 * judgement, so the lookups happen elsewhere, outside any transaction. What each step requires and
 * why: docs/design-notes/P3-2.md.
 */
export function evaluateDomain(domain: string, selector: string, txt: (name: string) => string[]): DomainCheck {
    const names = domainCheckNames(domain, selector);
    return {
        spf: spfStep(txt(names.spf)),
        dkim: dkimStep(names.dkim, txt(names.dkim)),
        dmarc: dmarcStep(names.dmarc, txt(names.dmarc)),
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
