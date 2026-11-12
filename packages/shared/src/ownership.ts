/**
 * Company-domain ownership (OWN-2, #201, FR-CRMS-20): the member who owns a company owns every person
 * at it and every deal with it. A company is found by its domain or one of its other domains; a person
 * by their primary address's domain, free mail left out.
 */

/**
 * A company's domain as it is stored and compared (OWN-2c): lower case, no scheme, no `www.`, no port, path,
 * query or trailing dot. `https://www.Acme.com/about` and `acme.com` are one company.
 */
export function bareDomain(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, '')
        .replace(/\.$/, '')
        .replace(/^www\./, '');
}

/** Providers whose domain says nothing about a company: a person there is simply a person with mail. */
const FREE_MAIL =
    /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|yandex|zoho|fastmail|hey|tutanota|tuta|pm)\.[a-z.]+$/i;

/**
 * Consumer mailboxes an internet provider or a portal hands out, by their exact domain: the provider's own staff
 * write from another (`verizon.com`, not `verizon.net`), so these cannot be listed by name alone as `FREE_MAIL` is.
 * A "company" at one of these would be one member's account holding every subscriber's address.
 */
const CONSUMER_MAIL: ReadonlySet<string> = new Set([
    // North America
    'comcast.net',
    'att.net',
    'bellsouth.net',
    'sbcglobal.net',
    'verizon.net',
    'cox.net',
    'charter.net',
    'earthlink.net',
    'optonline.net',
    'rr.com',
    'roadrunner.com',
    'juno.com',
    'netzero.net',
    'windstream.net',
    'centurylink.net',
    'frontiernet.net',
    'shaw.ca',
    'telus.net',
    'sympatico.ca',
    'videotron.ca',
    // Europe
    'btinternet.com',
    'ntlworld.com',
    'talktalk.net',
    'blueyonder.co.uk',
    'web.de',
    't-online.de',
    'freenet.de',
    'orange.fr',
    'wanadoo.fr',
    'free.fr',
    'laposte.net',
    'sfr.fr',
    'libero.it',
    'virgilio.it',
    'seznam.cz',
    'wp.pl',
    'o2.pl',
    'bluewin.ch',
    // Asia-Pacific
    'naver.com',
    'daum.net',
    'hanmail.net',
    '163.com',
    '126.com',
    'yeah.net',
    '139.com',
    'qq.com',
    'foxmail.com',
    'sina.com',
    'sina.cn',
    'sohu.com',
    'aliyun.com',
    'rediffmail.com',
    'bigpond.com',
    'optusnet.com.au',
    // Anyone's
    'email.com',
    'duck.com',
]);

export function isFreeMailDomain(domain: string): boolean {
    const bare = domain.trim().toLowerCase();
    return FREE_MAIL.test(bare) || CONSUMER_MAIL.has(bare);
}

/** The bare domain an address is at when it can be a company's; null for free mail or no domain. */
export function companyDomainOfAddress(address: string | null | undefined): string | null {
    const at = address ? address.lastIndexOf('@') : -1;
    if (!address || at <= 0) return null;
    const domain = bareDomain(address.slice(at + 1));
    return domain.includes('.') && !isFreeMailDomain(domain) ? domain : null;
}

/** What a `409 conflict.company_owned` says in `details`. */
export interface CompanyOwnedDetails {
    companyId: string;
    companyName: string;
    ownerMemberId: string;
    ownerName: string;
    [key: string]: string;
}

/** One of a company's other domains (a group's second brand, a country site). */
export interface CompanyDomainView {
    domain: string;
    /** ISO 8601. */
    createdAt: string;
}

export const OWNERSHIP_CONFLICT_KINDS = [
    /** OWN-2c: a company saved before domains were compared bare, whose domain is another company's with `www.`. */
    'duplicate_domain',
    /** A person's address is at a company another member owns. */
    'domain_owned_by_other',
    /** A person, or a deal, is linked to a company another member owns. */
    'company_owner_differs',
] as const;
export type OwnershipConflictKind = (typeof OWNERSHIP_CONFLICT_KINDS)[number];

/** One record the rule disagrees with, for a manager to resolve (the backfill report). */
export interface OwnershipConflictView {
    kind: OwnershipConflictKind;
    object: 'person' | 'opportunity' | 'company';
    recordId: string;
    recordLabel: string;
    recordOwnerMemberId: string | null;
    recordOwnerName: string | null;
    companyId: string;
    companyName: string;
    companyOwnerMemberId: string;
    companyOwnerName: string | null;
}

/** The transfer cooling period's default and bounds, in days (OWN-1, owner decision 2). `0` turns it off. */
export const TRANSFER_COOLING_DAYS_DEFAULT = 14;
export const TRANSFER_COOLING_DAYS_LIMITS = { min: 0, max: 90 } as const;

/**
 * OWN-2f: the months an owner may leave a company untouched and keep it — its default and bounds. `0` turns it off:
 * an owner keeps a company however long it is left.
 */
export const DORMANT_OWNER_MONTHS_DEFAULT = 6;
export const DORMANT_OWNER_MONTHS_LIMITS = { min: 0, max: 36 } as const;

/** A workspace's ownership settings (Settings → Ownership). */
export interface OwnershipSettingsView {
    /**
     * Days after a transfer during which the record cannot go back to the member it left — not offered to them,
     * not accepted by them. Managers and admins (`record:transfer`), and their forced transfers, are exempt.
     */
    transferCoolingDays: number;
    /**
     * OWN-2f: months after which an owner who has not worked a company (no open deal, no mail, nothing saved or done
     * there, no hand-over to them) holds it for nobody — its leads are anyone's, and the next member to save a
     * person there takes it over. 0 turns it off.
     */
    dormantOwnerMonths: number;
}

/** What a `409 conflict.transfer_cooling` says in `details`. */
export interface TransferCoolingDetails {
    /** ISO 8601: when the member may take the record again. */
    unlocksAt: string;
    coolingDays: number;
    [key: string]: string | number;
}
