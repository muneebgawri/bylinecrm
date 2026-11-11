import { offCrmColdFindings, poachFindings, type PoachFacts, type PoachRecipient } from '../guardrails/poach-rules';

/**
 * GUARD-4's rule, as a pure function over the facts GUARD-2 and GUARD-3 already read: a message Google
 * Workspace routed through the relay may leave when every outside recipient is the sender's own customer or
 * prospect, a colleague, or someone answered in a thread they wrote in. Each other recipient is a refusal:
 * another member's lead (`poach_suspected` — the mail would be poaching) or nobody the CRM knows
 * (`off_crm_cold` — cold outreach goes through the CRM). A reply in a thread the lead's owner is on is neither
 * (GUARD-3 never sees replies; here they pass). One message is one verdict: a single refused
 * recipient bounces the whole message, so the rep sees exactly who and why, and nothing half-leaves.
 */
export type RelayFacts = PoachFacts;

export type RelayRefusalKind = 'poach_suspected' | 'off_crm_cold';

export interface RelayRefusal {
    address: string;
    kind: RelayRefusalKind;
    personId: string | null;
    companyId: string | null;
    /** Whose lead it is (`poach_suspected`); null for a customer on the exclusions nobody owns, or cold mail. */
    ownerId: string | null;
    exclusion: { source: string; reason: string } | null;
}

export function relayRefusals(facts: RelayFacts): RelayRefusal[] {
    const refusals = new Map<string, RelayRefusal>();
    for (const f of poachFindings(facts)) {
        refusals.set(f.address, {
            address: f.address,
            kind: 'poach_suspected',
            personId: f.personId,
            companyId: f.companyId,
            ownerId: f.ownerId,
            exclusion: f.exclusion,
        });
    }
    const ownerOnThread = new Map(
        facts.recipients.map((r) => [
            r.address.toLowerCase(),
            r.ownerId !== null && facts.threadMembers.has(r.ownerId),
        ]),
    );
    for (const f of offCrmColdFindings(facts)) {
        if (refusals.has(f.address)) continue;
        // A reply in a thread the lead's owner is on (they copied the sender): collaboration, not cold mail.
        if (ownerOnThread.get(f.address)) continue;
        refusals.set(f.address, {
            address: f.address,
            kind: 'off_crm_cold',
            personId: f.personId,
            companyId: f.companyId,
            ownerId: null,
            exclusion: null,
        });
    }
    return [...refusals.values()];
}

/** What the sender's mail client shows: the bounce text, one line per refused address, then what to do. */
export function relayBounceText(
    refusals: readonly RelayRefusal[],
    ownerNames: ReadonlyMap<string, string>,
    crmUrl: string,
): string {
    const lines = refusals.map((r) => {
        if (r.kind === 'off_crm_cold')
            return `${r.address}: not one of your contacts — cold outreach is sent from Byline CRM, not Gmail.`;
        const owner = r.ownerId ? ownerNames.get(r.ownerId) : null;
        if (owner) return `${r.address}: ${owner}'s lead — ask them, or send from Byline CRM.`;
        if (r.exclusion) return `${r.address}: a customer (${r.exclusion.source}) — send from Byline CRM.`;
        return `${r.address}: another member's lead — send from Byline CRM.`;
    });
    return [
        'Byline CRM did not send this email.',
        ...lines,
        `Open the contact in ${crmUrl} and send from there. Replies to people who wrote to you are not affected.`,
    ].join('\n');
}

/** What the guardrail event says: who tried, whom, when and the subject — never the body. */
export function relayBlockedMessage(input: {
    senderName: string;
    senderAddress: string;
    refusal: RelayRefusal;
    ownerName: string | null;
    subject: string;
    at: Date;
}): string {
    const when = `${input.at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const subject = input.subject.trim() === '' ? '(no subject)' : `“${input.subject.trim().slice(0, 200)}”`;
    const whose =
        input.refusal.kind === 'off_crm_cold'
            ? 'cold mail'
            : input.ownerName
              ? `${input.ownerName}’s lead`
              : input.refusal.exclusion
                ? `a customer (${input.refusal.exclusion.source})`
                : 'another member’s lead';
    return `${input.senderName} (${input.senderAddress}) tried to send ${input.refusal.address} ${whose} from Gmail; the relay bounced it, ${when}: ${subject}`;
}

export type { PoachRecipient };
