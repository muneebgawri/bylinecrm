import type { TransferMember } from './transfers.js';

/**
 * Recipient guardrails (GUARD-1, #202, FR-CRMS-21): one guard every outbound path consults — a send now, a
 * reply, a scheduled send at its time, a sequence enrolment and every sequence step — so an account manager
 * cannot mail another account manager's lead, a customer, or a prospect someone else is negotiating with.
 * Every block (and every attempt a manager was allowed through) is written to `guardrail_events`, the audit
 * a manager reads on the Guardrails page. GUARD-2 (Gmail sync detection) and REP-1/2 (sender reputation)
 * add their kinds and paths to the same table.
 */

/**
 * Why the guard stopped (or flagged) a recipient, in the order it asks:
 *
 * 1. `suppressed` — on the suppression list (P3-1).
 * 2. `excluded_customer` / `excluded_account_managed` — on the outreach exclusions (FR-CRMS-10).
 * 3. `owned_by_other` — the person, or the company at the address's domain, is another member's.
 * 4. `in_negotiation` — the address's company has an open deal another member owns (reported instead of 3).
 * 5. `cold_to_known` — a sequence enrolment of someone already in a two-way thread with the workspace.
 *
 * `repeat_blocks` is not a recipient's: three blocks on owned addresses by one member in a day.
 * `record_export` is the export audit (GUARD-1b): who exported which records, how many, and whether only their own.
 *
 * Sender reputation (REP-1, FR-CRMS-23), about a mailbox rather than a recipient:
 * - `send_budget` — a send refused (or, for the pool, deferred) by a mailbox's daily or hourly budget.
 * - `volume_anomaly` — sync saw a mailbox over its daily new-recipient budget (mail sent outside the CRM).
 * - `bulk_pattern` — near-identical 1:1 bodies to many distinct recipients in 24 hours (simhash).
 * - `subject_repeat` — one normalised subject to many distinct new recipients in 24 hours.
 * - `negative_reply` — a reply saying "unsubscribe" / "remove me" to a mailbox's mail.
 * - `primary_domain` — a sequence send or enrolment refused because the pool mailbox is on the primary domain.
 *
 * REP-2 (FR-CRMS-24):
 * - `recipient_quality` — a pool send to an address verification finds `invalid` (blocked) or `risky` (warned).
 * - `reply_rate` — a mailbox paused for new recipients: its reply rate fell under the floor.
 * - `spam_rate` — a sending domain's Postmaster spam rate reached the warn line or the kill switch.
 */
export const GUARDRAIL_KINDS = [
    'suppressed',
    'excluded_customer',
    'excluded_account_managed',
    'owned_by_other',
    'in_negotiation',
    'cold_to_known',
    'repeat_blocks',
    'record_export',
    // REP-1 (FR-CRMS-23): sender reputation.
    'send_budget',
    'volume_anomaly',
    'bulk_pattern',
    'subject_repeat',
    'negative_reply',
    'primary_domain',
    // REP-2 (FR-CRMS-24): quality gate and kill switches.
    'recipient_quality',
    'reply_rate',
    'spam_rate',
] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

/** The kinds that are about another member's lead: they count toward `repeat_blocks`. */
export const OWNED_GUARDRAIL_KINDS: readonly GuardrailKind[] = ['owned_by_other', 'in_negotiation'];

/**
 * What the guard did: refused the recipient (`blocked`), let it through with a warning (`warned` — the
 * owner enrolling their own warm contact), or let an exempt sender through and kept the record (`allowed` —
 * a holder of `record:transfer` mailing someone else's lead). `deferred` (REP-1): a pool send held for later
 * by a budget — the sequence tries the step again.
 */
export const GUARDRAIL_OUTCOMES = ['blocked', 'warned', 'allowed', 'deferred'] as const;
export type GuardrailOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

export const GUARDRAIL_SEVERITIES = ['low', 'medium', 'high'] as const;
export type GuardrailSeverity = (typeof GUARDRAIL_SEVERITIES)[number];

/**
 * Where the attempt came from: a send now (`send`), a reply (`reply`), a scheduled send at its time
 * (`scheduled_send`, a retry included), putting people in a sequence (`sequence_enrol`, one or many), a
 * sequence step's send at its time (`sequence_step`), or (`repeat_blocks`) the guard's own tally.
 */
export const GUARDRAIL_PATHS = [
    'send',
    'reply',
    'scheduled_send',
    'sequence_enrol',
    'sequence_step',
    'repeat_blocks',
    'export',
    // REP-1: what Gmail sync measured (mail that left without the CRM), and the pool's gate at send time.
    'sync',
    'pool_send',
] as const;
export type GuardrailPath = (typeof GUARDRAIL_PATHS)[number];

/** Blocks on owned addresses by one member in a UTC day that tell the managers (`guardrail_repeat_blocks`). */
export const GUARDRAIL_REPEAT_BLOCKS_PER_DAY = 3;

/** How long a "mark legitimate" reason may be. */
export const GUARDRAIL_REASON_MAX = 1000;

/** The page's words for each kind. */
export const GUARDRAIL_KIND_LABELS: Readonly<Record<GuardrailKind, string>> = {
    suppressed: 'Suppressed',
    excluded_customer: 'Customer',
    excluded_account_managed: 'Account-managed',
    owned_by_other: 'Another member’s lead',
    in_negotiation: 'In negotiation with another member',
    cold_to_known: 'Cold sequence to a warm contact',
    repeat_blocks: 'Repeated blocks',
    record_export: 'Export',
    send_budget: 'Send budget',
    volume_anomaly: 'Volume over budget (Gmail)',
    bulk_pattern: 'Bulk pattern (near-identical mail)',
    subject_repeat: 'Repeated subject',
    negative_reply: 'Negative reply',
    primary_domain: 'Primary domain protected',
    recipient_quality: 'Recipient quality',
    reply_rate: 'Reply rate under the floor',
    spam_rate: 'Domain spam rate',
};

/** The kinds that are about a mailbox's sending rather than one recipient (REP-1). */
export const REPUTATION_GUARDRAIL_KINDS: readonly GuardrailKind[] = [
    'send_budget',
    'volume_anomaly',
    'bulk_pattern',
    'subject_repeat',
    'negative_reply',
    'primary_domain',
    'recipient_quality',
    'reply_rate',
    'spam_rate',
];

/** One guardrail event, as the Guardrails page reads it. */
export interface GuardrailEventView {
    id: string;
    kind: GuardrailKind;
    outcome: GuardrailOutcome;
    severity: GuardrailSeverity;
    path: GuardrailPath;
    /** Who tried; null once their seat is gone. */
    actor: TransferMember | null;
    /** Whose lead it was (for `owned_by_other` / `in_negotiation`); null otherwise. */
    owner: TransferMember | null;
    personId: string | null;
    companyId: string | null;
    address: string | null;
    /** What the guard said, as the sender read it. */
    message: string;
    /** ISO 8601. */
    createdAt: string;
    /** Set once a reviewer marked the event legitimate, with why. */
    legitimate: { by: TransferMember | null; reason: string; at: string } | null;
}

export interface GuardrailEventsPage {
    items: GuardrailEventView[];
    /** Pass as `cursor` for the next page; null on the last. */
    nextCursor: string | null;
}

/** What the bell shows for a `guardrail_repeat_blocks` notification. */
export interface GuardrailSummary {
    id: string;
    kind: GuardrailKind;
    actor: TransferMember | null;
    /** How many blocks on owned addresses that member had that day when it fired. */
    count: number;
    /** What the event said (REP-1: the alert's own words, for a `guardrail_alert`). */
    message: string;
}

/**
 * What a `guardrail.recorded` event carries (GUARD-1b): the event as the Guardrails page reads it, by ids —
 * never a message body (the guard never sees one) and never a CSV's rows.
 */
export interface GuardrailEventPayload {
    kind: GuardrailKind;
    outcome: GuardrailOutcome;
    severity: GuardrailSeverity;
    path: GuardrailPath;
    actorMemberId: string | null;
    ownerMemberId: string | null;
    personId: string | null;
    companyId: string | null;
    address: string | null;
    /** What the guard told the sender, or what the export held. */
    message: string;
    /** Machine facts: an export's `object`, `scope` (`own` / `all`) and `rows`; the day's `count`. */
    detail: Record<string, string>;
}
