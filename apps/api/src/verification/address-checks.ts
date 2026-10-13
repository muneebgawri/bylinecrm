import { domainToASCII } from 'node:url';
import disposableDomains from 'disposable-email-domains';
import { ROLE_LOCAL_PARTS, type EmailVerification } from '@bylinecrm/shared';
import type { MxLookup } from '../sending-pool/dns.port';

/** An address that parses: as stored and compared (lower case), and its two halves as written. */
export interface ParsedAddress {
    address: string;
    local: string;
    domain: string;
}

/** What the free layer decides; the verifier adds its `source`. */
export type EmailVerdict = Omit<EmailVerification, 'source'>;

/** A dot-atom local part (RFC 5322 §3.4.1): the practical form; quoted local parts are not accepted. */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LOCAL_PART_MAX = 64;
/** A host name label (RFC 1035 §2.3.1, letters, digits and inner hyphens), and a top-level label of letters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LABEL = /^[a-z]{2,63}$/;
const DOMAIN_MAX = 253;
const ADDRESS_MAX = 254;

/**
 * Syntax: exactly one `@`, a dot-atom local part, and a dotted host name whose last label is a
 * letters-only TLD. An internationalised domain is taken by its ASCII (punycode) form. `null` when
 * it is not an address at all.
 */
export function parseAddress(raw: string): ParsedAddress | null {
    const trimmed = raw.trim();
    const at = trimmed.indexOf('@');
    if (at < 1 || at !== trimmed.lastIndexOf('@')) return null;
    const local = trimmed.slice(0, at);
    if (local.length > LOCAL_PART_MAX || !LOCAL_PART.test(local)) return null;
    const domain = domainToASCII(trimmed.slice(at + 1).toLowerCase());
    if (!domain || domain.length > DOMAIN_MAX) return null;
    const labels = domain.split('.');
    if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TOP_LABEL.test(labels.at(-1)!)) {
        return null;
    }
    const address = `${local.toLowerCase()}@${domain}`;
    return address.length > ADDRESS_MAX ? null : { address, local, domain };
}

const roleLocalParts = new Set(ROLE_LOCAL_PARTS);

/** A local part that names a function (info, sales, press…), not a person. */
export function isRoleAddress(local: string): boolean {
    return roleLocalParts.has(local.toLowerCase());
}

const disposable = new Set<string>(disposableDomains);

/** A domain on the maintained list of throwaway-mailbox providers; exact match, never a look-alike. */
export function isDisposableDomain(domain: string): boolean {
    return disposable.has(domain.toLowerCase());
}

/** RFC 7505: a single MX record whose exchange is the root (`.`) says the domain accepts no mail. */
function isNullMx(exchanges: readonly string[]): boolean {
    return exchanges.length > 0 && exchanges.every((exchange) => exchange === '.' || exchange === '');
}

/**
 * The verdict from the syntax and the domain's MX lookup (P3-5, FR-CRMS-14) — a pure judgement, so
 * the lookup happens elsewhere, outside any transaction. In order: not an address; no such domain;
 * a domain with no mail server; a null MX; a disposable domain (#165: a throwaway inbox is never
 * worth a cold email) — each `invalid`. A role address is `risky`: mail may arrive, but not to a
 * person. A lookup that failed is `unknown` — not valid.
 */
export function judgeAddress(raw: string, mx: MxLookup | 'failed'): EmailVerdict {
    const parsed = parseAddress(raw);
    if (!parsed) return { result: 'invalid', reason: 'syntax', message: 'Not an email address' };
    const { local, domain } = parsed;
    if (mx === 'failed') {
        return {
            result: 'unknown',
            reason: 'lookup_failed',
            message: `Could not verify ${domain}: the DNS lookup failed; it is tried again at the next check`,
        };
    }
    if (mx.status === 'no_domain')
        return { result: 'invalid', reason: 'no_domain', message: `No such domain: ${domain}` };
    if (mx.status === 'no_records') {
        return { result: 'invalid', reason: 'no_mail_server', message: `${domain} has no mail server (no MX record)` };
    }
    if (isNullMx(mx.exchanges)) {
        return { result: 'invalid', reason: 'null_mx', message: `${domain} accepts no mail (null MX)` };
    }
    if (isDisposableDomain(domain)) {
        return {
            result: 'invalid',
            reason: 'disposable',
            message: `Disposable address: ${domain} hands out throwaway mailboxes`,
        };
    }
    if (isRoleAddress(local)) {
        return {
            result: 'risky',
            reason: 'role',
            message: `Role address (${local.toLowerCase()}@): may not reach a person`,
        };
    }
    return { result: 'valid', reason: 'deliverable', message: `Deliverable: ${domain} has a mail server` };
}
