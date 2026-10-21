/**
 * Pipelines and stages (corpus doc 48 FR-CRMS-9; parity ledger PAR-007/008). One vocabulary for
 * the API, the migration's backfill (asserted against this list by a test) and the web app.
 */

/** What a stage means for the deal in it: still open, or closed one way or the other. */
export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/**
 * Why a deal entered a stage: a member moved it, a rule did, an import placed it, it was closed,
 * or the stage it was in was deleted and its deals moved on (P1-2b).
 */
export const STAGE_HISTORY_REASONS = ['manual', 'rule', 'import', 'close', 'stage_deleted'] as const;
export type StageHistoryReason = (typeof STAGE_HISTORY_REASONS)[number];

/**
 * The most deals one stage delete may move (P1-2b). The move is one transaction; past this the
 * request is refused with `payload_too_large` rather than holding the pipeline locked for long.
 */
export const STAGE_DELETE_MOVE_LIMIT = 5000;

/**
 * The events a stage rule may react to. Mail (P2) and meetings (P3) emit them; the rule engine
 * (P1-2) listens for them from the day the enum exists, so a rule saved now works the day the
 * event first fires. A tracked link clicked (P3-4) is one; an open never is — opens are indicative
 * (FR-CRMS-8) and may not move a deal.
 */
// A verified invoice (INV-1) is one too: it moves the deal it is on once its verified invoices cover the amount.
export const STAGE_RULE_EVENTS = ['email.replied', 'meeting.booked', 'email.clicked', 'invoice.verified'] as const;
export type StageRuleEvent = (typeof STAGE_RULE_EVENTS)[number];

/** The colour a stage is drawn in: a semantic token name, never a colour value. */
export const STAGE_COLOURS = ['neutral', 'accent', 'info', 'ok', 'warn', 'bad'] as const;
export type StageColour = (typeof STAGE_COLOURS)[number];

export interface DefaultStage {
    name: string;
    kind: StageKind;
    probability: number;
    colour: StageColour;
}

/** The pipeline every workspace starts with. */
export const DEFAULT_PIPELINE_NAME = 'Sales pipeline';

/**
 * Its stages, in order. The migration that introduced pipelines backfilled existing workspaces
 * from this same list (a unit test holds the SQL to it), and `seedDefaultPipeline` creates it for
 * every workspace made since.
 */
export const DEFAULT_STAGES: readonly DefaultStage[] = [
    { name: 'New', kind: 'open', probability: 10, colour: 'neutral' },
    { name: 'Contacted', kind: 'open', probability: 20, colour: 'info' },
    { name: 'Replied', kind: 'open', probability: 40, colour: 'accent' },
    { name: 'Meeting', kind: 'open', probability: 60, colour: 'warn' },
    { name: 'Won', kind: 'won', probability: 100, colour: 'ok' },
    { name: 'Lost', kind: 'lost', probability: 0, colour: 'bad' },
];

/** How many deals a board column carries before it says there are more. */
export const BOARD_STAGE_LIMIT = 200;

/**
 * Why a deal was lost (#242): a fixed picklist, required whenever a deal moves into a lost stage. A member picks
 * one in the move-to-lost dialog (the API refuses a member's close without it); a stage rule or an import that
 * closes a deal as lost, naming no reason it can map, records `DEFAULT_LOST_REASON`. The free-text `lostReason`
 * stays beside it for detail.
 */
export const LOST_REASONS = [
    'price_budget',
    'no_response',
    'chose_competitor',
    'not_ready',
    'service_not_suitable',
    'timing',
    'duplicate_opportunity',
    'other',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABELS: Readonly<Record<LostReason, string>> = {
    price_budget: 'Price/Budget',
    no_response: 'No Response',
    chose_competitor: 'Chose Competitor',
    not_ready: 'Not Ready',
    service_not_suitable: 'Service Not Suitable',
    timing: 'Timing',
    duplicate_opportunity: 'Duplicate Opportunity',
    other: 'Other',
};

/**
 * What a rule- or import-driven close records when it names no reason it can map. `other` rather than
 * `no_response`: a rule or an import does not know the prospect went silent, and `other` never claims what nobody
 * said.
 */
export const DEFAULT_LOST_REASON: LostReason = 'other';

/**
 * The picklist value a free-text reason (an imported CRM's, a legacy deal's) means, or `null` when it names none.
 * Matches the code (`NO_RESPONSE`), the label (`No Response`) or a few common spellings, case-insensitively.
 */
export function lostReasonFromText(text: string | null | undefined): LostReason | null {
    if (!text) return null;
    const t = text
        .toLowerCase()
        .replace(/[^a-z]+/g, ' ')
        .trim();
    if (!t) return null;
    const patterns: readonly [LostReason, RegExp][] = [
        ['duplicate_opportunity', /\bduplicate\b/],
        ['price_budget', /\b(price|pricing|budget|cost|expensive)\b/],
        ['no_response', /\b(no response|no reply|unresponsive|ghosted|no answer)\b/],
        ['chose_competitor', /\b(competitor|competition|chose another|went with)\b/],
        ['not_ready', /\bnot ready\b/],
        ['service_not_suitable', /\b(not suitable|not a fit|no fit|unsuitable|service not)\b/],
        ['timing', /\b(timing|bad time|next year|next quarter)\b/],
        ['other', /^other$/],
    ];
    for (const [reason, pattern] of patterns) if (pattern.test(t)) return reason;
    return null;
}
