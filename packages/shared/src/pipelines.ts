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
export const STAGE_RULE_EVENTS = ['email.replied', 'meeting.booked', 'email.clicked'] as const;
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
