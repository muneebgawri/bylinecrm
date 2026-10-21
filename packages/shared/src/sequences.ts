import type { Actor, TaskStatus } from './records.js';
import type { TrackingCounts } from './tracking.js';

/**
 * Sequences and the outreach compliance they enforce (P3-3, FR-CRMS-5, -10, -11, -12): what the API,
 * the web app and the tests share. Why each rule is what it is: docs/design-notes/P3-3.md.
 */

// ── Region policy (FR-CRMS-12) ───────────────────────────────────────────────────────────────

/** The regions a workspace sets an outreach policy for. `unknown`: no country could be inferred. */
export const REGION_CODES = ['eu', 'uk', 'ca', 'us', 'other', 'unknown'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

/**
 * Whether outreach to a region is allowed until a workspace says otherwise. EU, UK and Canada are
 * blocked (D-247): a workspace opens one only with its own lawful basis, stated.
 */
export const DEFAULT_REGION_POLICY: Readonly<Record<RegionCode, boolean>> = {
    eu: false,
    uk: false,
    ca: false,
    us: true,
    other: true,
    unknown: true,
};

/** The region names a refusal says. */
export const REGION_LABELS: Readonly<Record<RegionCode, string>> = {
    eu: 'EU',
    uk: 'UK',
    ca: 'Canada',
    us: 'US',
    other: 'other countries',
    unknown: 'unknown country',
};

/** The EU's 27 member states, ISO 3166-1 alpha-2. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'DE',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
]);

/** The region of a country (ISO alpha-2, upper case), or `unknown` for none. */
export function regionOfCountry(country: string | null): RegionCode {
    if (!country) return 'unknown';
    if (EU_COUNTRIES.has(country)) return 'eu';
    if (country === 'GB') return 'uk';
    if (country === 'CA') return 'ca';
    if (country === 'US') return 'us';
    return 'other';
}

/** One region's policy as the API reports it: the effective value and whether it is the default. */
export interface RegionPolicyEntry {
    region: RegionCode;
    allowed: boolean;
    isDefault: boolean;
    /** Required when a region blocked by default is allowed. */
    lawfulBasis: string | null;
    updatedAt: string | null;
}

export const REGION_LAWFUL_BASIS_MAX = 1000;

/**
 * One change to a region's policy (#141): what it became, the lawful basis stated, and who made it. The
 * history is append-only; the settings page shows the newest `REGION_POLICY_CHANGES_LIMIT`.
 */
export interface RegionPolicyChange {
    id: string;
    region: RegionCode;
    allowed: boolean;
    lawfulBasis: string | null;
    /** The member's name, or null when that member has since been removed. */
    changedBy: string | null;
    changedAt: string;
}

export const REGION_POLICY_CHANGES_LIMIT = 100;

// ── Outreach exclusions (FR-CRMS-10) ─────────────────────────────────────────────────────────

export const EXCLUSION_REASONS = ['customer', 'account_managed'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface OutreachExclusionView {
    id: string;
    /** One of `address` / `domain` is set. */
    address: string | null;
    domain: string | null;
    reason: ExclusionReason;
    accountManagerName: string | null;
    /** Who said so: an integration's key (`newswireos`) or `manual`. */
    source: string;
    externalRef: string | null;
    note: string | null;
    createdAt: string;
    /**
     * #242: set when an automatic customer exclusion (`source: won_deal`) may no longer hold: its deal was reopened
     * (`deal_reopened`) or fully refunded (`deal_refunded`). The exclusion stays until an admin removes it or
     * dismisses the flag; nothing removes it on its own.
     */
    reviewReason: ExclusionReviewReason | null;
    reviewFlaggedAt: string | null;
}

export const EXCLUSION_REVIEW_REASONS = ['deal_reopened', 'deal_refunded'] as const;
export type ExclusionReviewReason = (typeof EXCLUSION_REVIEW_REASONS)[number];

/** The `source` of the exclusion a won deal adds (#242); its `externalRef` is the deal's id. */
export const WON_DEAL_EXCLUSION_SOURCE = 'won_deal';

/**
 * What a won deal excludes (#242): its point of contact's primary address, or (an admin's choice, `domain`) their
 * company's domain, else the address's own domain. A free-mail domain is never excluded whole: the address is.
 */
export const WON_EXCLUSION_SCOPES = ['address', 'domain'] as const;
export type WonExclusionScope = (typeof WON_EXCLUSION_SCOPES)[number];

export interface CustomerExclusionSettingsView {
    wonExclusionScope: WonExclusionScope;
}

// ── Sequences (FR-CRMS-5) ────────────────────────────────────────────────────────────────────

export const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export const SEQUENCE_STEP_KINDS = ['email', 'wait', 'task'] as const;
export type SequenceStepKind = (typeof SEQUENCE_STEP_KINDS)[number];

/** Monday-first bitmask of the days a sequence sends on: bit 0 Monday … bit 6 Sunday. */
export const WEEKDAYS_MASK = 0b0011111;

export const SEQUENCE_LIMITS = {
    name: 200,
    steps: 30,
    waitDays: { min: 1, max: 90 },
    taskTitle: 200,
    enrolBatch: 500,
    stopNote: 1000,
} as const;

/** The send window a new sequence has: 09:00–17:00 recipient's time, Monday to Friday. */
export const SEQUENCE_WINDOW_DEFAULTS = { startMinute: 9 * 60, endMinute: 17 * 60, days: WEEKDAYS_MASK } as const;

export interface SequenceStepView {
    id: string;
    position: number;
    kind: SequenceStepKind;
    /** `email` steps. */
    templateId: string | null;
    replyInThread: boolean;
    /** `wait` steps. */
    waitDays: number | null;
    businessDays: boolean;
    /** `task` steps (#136): the task created on the person, for their owner (else the enroller). */
    taskTitle: string | null;
    /** `email` steps (P3-4): clicks and indicative opens across the step's sends; zeros elsewhere. */
    tracking: TrackingCounts;
}

export interface SequenceCounts {
    enrolled: number;
    active: number;
    held: number;
    finished: number;
    stopped: number;
}

/**
 * Who sees a sequence (#192): `shared` — everyone who may enrol (every sequence before #192) — or
 * `private` — its owner and the workspace's admins only. Only the owner or an admin changes it.
 */
export const SEQUENCE_VISIBILITIES = ['shared', 'private'] as const;
export type SequenceVisibility = (typeof SEQUENCE_VISIBILITIES)[number];

export interface SequenceView {
    id: string;
    name: string;
    status: SequenceStatus;
    pipelineId: string | null;
    stopOnPipelineExit: boolean;
    timeZone: string;
    window: { startMinute: number; endMinute: number; days: number };
    steps: SequenceStepView[];
    /** Read from the enrolment rows, never a stored tally. */
    counts: SequenceCounts;
    createdBy: Actor;
    /** The member whose sequence it is (#192): who made it, or whose API key did; null when neither is known. */
    ownerMemberId: string | null;
    visibility: SequenceVisibility;
    createdAt: string;
    updatedAt: string;
}

// ── Enrolments ───────────────────────────────────────────────────────────────────────────────

export const ENROLMENT_STATUSES = ['active', 'held', 'finished', 'stopped'] as const;
export type EnrolmentStatus = (typeof ENROLMENT_STATUSES)[number];

/** Why an enrolment stopped. The first six are the mandatory stop conditions (doc 50 §D). */
export const ENROLMENT_STOP_REASONS = [
    'reply',
    'bounce',
    'unsubscribe',
    'complaint',
    'suppressed',
    'manual',
    'pipeline_exit',
    'excluded',
    'sequence_archived',
    'person_deleted',
    'region_blocked',
    // FR-CRMS-14: the address was found not deliverable when checked again before a step (P3-5).
    'invalid_address',
] as const;
export type EnrolmentStopReason = (typeof ENROLMENT_STOP_REASONS)[number];

/** Why a person cannot be enrolled — each the server's, never a guess (doc 50 §D). */
export const ENROLMENT_REFUSAL_CODES = [
    'person.not_found',
    'email.missing',
    'source.missing',
    'suppressed',
    'excluded',
    'region.blocked',
    // FR-CRMS-14 (P3-5): the address is not deliverable, or could not be verified — `unknown` does not enrol.
    'email.invalid',
    'email.unverified',
    // GUARD-1 (FR-CRMS-21): another member's lead, in negotiation with another member, or a warm contact
    // only their owner (or a manager) may put in a sequence.
    'owned_by_other',
    'in_negotiation',
    'cold_to_known',
] as const;
export type EnrolmentRefusalCode = (typeof ENROLMENT_REFUSAL_CODES)[number];

export interface EnrolmentRefusal {
    personId: string;
    code: EnrolmentRefusalCode;
    message: string;
}

/**
 * Enrolled, but worth a look: never blocks an enrolment. No known country (D-251); an address that
 * is deliverable but may not reach a person — a role address or a disposable domain (FR-CRMS-14); its
 * owner putting a warm contact in a sequence (GUARD-1, `cold_to_known`).
 */
export const ENROLMENT_WARNING_CODES = ['region.unknown', 'email.risky', 'cold_to_known'] as const;
export type EnrolmentWarningCode = (typeof ENROLMENT_WARNING_CODES)[number];

export interface EnrolmentWarning {
    personId: string;
    code: EnrolmentWarningCode;
    message: string;
}

export interface EnrolmentBatchResult {
    enrolled: string[];
    /** Already in this sequence: a no-op, never a second enrolment. */
    skipped: string[];
    refused: EnrolmentRefusal[];
    /** Enrolled people flagged for review (D-251: no known country; FR-CRMS-14: a risky address). */
    warnings: EnrolmentWarning[];
}

/** A task a `task` step made for this enrolment (#158): which step, and where the task stands. */
export interface EnrolmentTaskView {
    id: string;
    stepId: string;
    title: string;
    status: TaskStatus;
    dueAt: string | null;
    completedAt: string | null;
    assigneeId: string | null;
}

export interface EnrolmentView {
    id: string;
    sequenceId: string;
    personId: string;
    dealId: string | null;
    status: EnrolmentStatus;
    /** The step it is on (0-based, in position order); equals the step count once finished. */
    stepIndex: number;
    nextRunAt: string | null;
    /** The step's send while it waits for it. */
    waitingOutboundId: string | null;
    heldReason: string | null;
    stopReason: EnrolmentStopReason | null;
    stopDetail: string | null;
    enrolledBy: Actor;
    /** No country was known when they were enrolled (D-251); the region policy applies once one is. */
    countryUnknownAtEnrol: boolean;
    /** The member who enrolled the person: the sender of each step's send (#144). */
    enrolledByMemberId: string;
    enrolledAt: string;
    finishedAt: string | null;
    stoppedAt: string | null;
    /** The tasks its task steps made, in step order (#158). Completing one drives nothing. */
    tasks: EnrolmentTaskView[];
}

/** What `enrolment.*` events carry. */
export interface EnrolmentEventPayload {
    sequenceId: string;
    personId: string;
    stepIndex: number;
    reason?: EnrolmentStopReason;
    detail?: string;
}

/** What `email.failed` carries: the send and why it failed for good. */
export interface EmailFailure {
    outboundId: string;
    code: string;
    message: string;
}
