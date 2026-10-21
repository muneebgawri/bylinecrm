import type { StageKind } from './pipelines.js';

/**
 * Cadence and round-robin rotation (CADENCE-1, docs/design-notes/CADENCE-1.md): every open deal is due a touch a
 * number of days after its last, set by its stage; a missed cadence warns the owner, and a grace later the lead
 * rotates to the next rep. New unowned leads are dealt from the same rotation.
 */

/** The reason on a transfer the rotation forced. */
export const TRANSFER_REASON_CADENCE_ROTATION = 'cadence_rotation';

/** A planned follow-up defers a deal's due date, at most this many days past its last touch. */
export const CADENCE_FOLLOW_UP_MAX_DAYS = 14;

export const CADENCE_DAYS_MAX = 365;
export const ROTATION_WEIGHT_MAX = 5;

/** Whether a connected (or delegated) mailbox is preferred, required, or ignored in who is dealt to. */
export const MAILBOX_PREFERENCES = ['prefer', 'require', 'ignore'] as const;
export type MailboxPreference = (typeof MAILBOX_PREFERENCES)[number];

/** The owner's defaults (2026-10-21), by stage name; any other open stage takes `CADENCE_DEFAULT_DAYS`. */
const DEFAULT_CADENCE_BY_NAME: Readonly<Record<string, number>> = {
    'new opportunity': 1,
    new: 1,
    contacted: 3,
    qualified: 3,
    'proposal sent': 5,
    negotiation: 3,
};
export const CADENCE_DEFAULT_DAYS = 3;

/** A new stage's cadence: none for a closed stage. The migration backfilled existing stages by the same rule. */
export function defaultCadenceDays(name: string, kind: StageKind): number | null {
    if (kind !== 'open') return null;
    return DEFAULT_CADENCE_BY_NAME[name.trim().toLowerCase()] ?? CADENCE_DEFAULT_DAYS;
}

/** `GET/PUT /rotation/settings`. */
export interface RotationSettingsView {
    enabled: boolean;
    /** ISO 8601: when rotation was switched on; lapses are measured from here. Null while off. */
    enabledAt: string | null;
    warnAfterDays: number;
    graceDays: number;
    intakeEnabled: boolean;
    mailboxPreference: MailboxPreference;
    openLeadCap: number | null;
}

/** One member, as the rotation sees them. */
export interface RotationMemberView {
    memberId: string;
    name: string | null;
    email: string;
    roleName: string;
    /** In the rotation (their role's default, or an admin's choice). */
    included: boolean;
    /** Whether `included` is their role's default (admins and managers are out by default). */
    includedByDefault: boolean;
    paused: boolean;
    /** ISO 8601; when a pause ends by itself. */
    resumeAt: string | null;
    weight: number;
    hasMailbox: boolean;
    openLeads: number;
    /** Dealt to now: included, not paused, under the cap, and (if required) with a mailbox. */
    eligible: boolean;
}

/** What the hourly job would do to one open lead, now. */
export const ROTATION_PREVIEW_ACTIONS = ['warn', 'rotate', 'waiting'] as const;
export type RotationPreviewAction = (typeof ROTATION_PREVIEW_ACTIONS)[number];

export interface RotationPreviewItem {
    opportunityId: string;
    opportunityName: string;
    stageName: string;
    cadenceDays: number;
    owner: { memberId: string; name: string | null };
    /** ISO 8601. */
    lastTouchAt: string;
    dueAt: string;
    /** When the owner is (or would be) warned, and when the lead would rotate. */
    warnAt: string;
    rotateAt: string;
    /** `warn`: warned on the next run; `rotate`: rotated on the next run; `waiting`: warned, inside the grace. */
    action: RotationPreviewAction;
    /** Who it would go to on the next run (`rotate` only; null when nobody is eligible). */
    to: { memberId: string; name: string | null } | null;
}

/** `GET /rotation/preview`: every overdue open lead, and what rotation would do with them — nothing is written. */
export interface RotationPreviewView {
    /** As if switched on now, when rotation is off. */
    assumedEnabledAt: string;
    overdue: number;
    items: RotationPreviewItem[];
}

/** What the bell shows for a cadence warning. */
export interface CadenceLapseSummary {
    id: string;
    opportunityId: string;
    opportunityName: string;
    stageName: string;
    /** ISO 8601. */
    dueAt: string;
    rotateAt: string;
}
