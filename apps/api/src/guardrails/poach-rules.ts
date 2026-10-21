import { POACH_HIGH_LEADS, type GuardrailSeverity } from '@bylinecrm/shared';

/**
 * GUARD-2's rules (FR-CRMS-22), as pure functions over facts the detector read: which recipients of a message
 * that left a member's mailbox are suspected poaching, and how severe. No database, so they are unit-tested.
 */

/** A recipient of the message (to, cc or bcc), with what the workspace knows of them. */
export interface PoachRecipient {
    address: string;
    /** A participant who is a member of the workspace (internal mail). */
    memberId: string | null;
    personId: string | null;
    companyId: string | null;
    /** The lead's owner: the person's, else their company's (by link, else by the address's company domain). */
    ownerId: string | null;
    /** The outreach exclusion the address hits (a customer, an account-managed client), if any. */
    exclusion: { source: string; reason: string } | null;
}

export interface PoachFacts {
    /** The member who sent it. */
    senderId: string;
    recipients: readonly PoachRecipient[];
    /** The workspace's own domains (members', mailboxes', sending domains); free mail never among them. */
    internalDomains: ReadonlySet<string>;
    /** Members on the thread — any message of it, this one included (a cc'd colleague's reply is legitimate). */
    threadMembers: ReadonlySet<string>;
    /** Addresses that wrote in the thread before (an answer to a customer who wrote in is legitimate). */
    threadSenders: ReadonlySet<string>;
}

export interface PoachFinding {
    address: string;
    personId: string | null;
    companyId: string | null;
    /** Whose lead it is; null for a customer on the exclusions that nobody owns. */
    ownerId: string | null;
    exclusion: { source: string; reason: string } | null;
}

export function domainOf(address: string): string {
    return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** Whether an address is the workspace's own: a domain listed, or a subdomain of one. */
export function isInternal(address: string, internalDomains: ReadonlySet<string>): boolean {
    const domain = domainOf(address);
    for (const own of internalDomains) if (domain === own || domain.endsWith(`.${own}`)) return true;
    return false;
}

/**
 * The recipients a message poaches:
 *
 * - **Owned by another member** (Y ≠ sender) — unless Y is on the thread (a reply where Y is, or Y copied).
 * - **A customer on the exclusions** — unless the sender owns them, or the customer wrote in the thread first.
 *
 * Members and the workspace's own domains are never findings (internal mail is not outreach). One finding per
 * address.
 */
export function poachFindings(facts: PoachFacts): PoachFinding[] {
    const seen = new Set<string>();
    const findings: PoachFinding[] = [];
    for (const r of facts.recipients) {
        const address = r.address.toLowerCase();
        if (seen.has(address)) continue;
        seen.add(address);
        if (r.memberId || isInternal(address, facts.internalDomains)) continue;
        // The sender's own lead, or a reply in a thread its owner is on: legitimate.
        if (r.ownerId === facts.senderId) continue;
        if (r.ownerId !== null && facts.threadMembers.has(r.ownerId)) continue;
        const excluded = r.exclusion !== null && !facts.threadSenders.has(address);
        if (r.ownerId === null && !excluded) continue;
        findings.push({
            address,
            personId: r.personId,
            companyId: r.companyId,
            ownerId: r.ownerId,
            exclusion: r.exclusion,
        });
    }
    return findings;
}

/**
 * The severity ladder: a first contact is `medium`; once the sender has reached `POACH_HIGH_LEADS` distinct leads
 * (this one included) in the window, `high`.
 */
export function poachSeverity(distinctLeadsInWindow: number): GuardrailSeverity {
    return distinctLeadsInWindow >= POACH_HIGH_LEADS ? 'high' : 'medium';
}

/** The key a lead is counted by: the person when known, else the address. */
export function leadKey(finding: { personId: string | null; address: string | null }): string {
    return finding.personId ?? finding.address ?? '';
}

/** What the alert says: who, whom, when and the subject — never the body. */
export function poachMessage(input: {
    senderName: string;
    senderAddress: string;
    address: string;
    ownerName: string | null;
    exclusionSource: string | null;
    sentAt: Date;
    subject: string;
}): string {
    const whose = input.ownerName
        ? `, ${input.ownerName}’s lead`
        : input.exclusionSource
          ? `, a customer (${input.exclusionSource})`
          : '';
    const when = `${input.sentAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const subject = input.subject.trim() === '' ? '(no subject)' : `“${input.subject.trim().slice(0, 200)}”`;
    return `${input.senderName} (${input.senderAddress}) wrote to ${input.address}${whose}, ${when}: ${subject}`;
}
