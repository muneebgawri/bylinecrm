import type { StageColour } from '@bylinecrm/shared';
import type { Tone } from '@bylinecrm/ui';

/** The two renderings of one result set (FR-CRMS-UI-3). */
export const DEALS_VIEWS = ['board', 'list'] as const;
export type DealsView = (typeof DEALS_VIEWS)[number];
export const isDealsView = (value: unknown): value is DealsView =>
    typeof value === 'string' && (DEALS_VIEWS as readonly string[]).includes(value);

/** The person's last choice of rendering, under the shell's storage convention. */
export const DEALS_VIEW_KEY = 'bylinecrm.deals.view';

/** The URL's names for the page's state, so a shared link opens the same deals the same way. */
export const DEALS_PARAMS = {
    pipeline: 'pipeline',
    render: 'show',
    view: 'view',
    filter: 'filter',
    sort: 'sort',
    q: 'q',
    create: 'create',
} as const;

/** Past this many cards a lane virtualises its list (doc 50 §B "⋮ 10 more is the fold"). */
export const LANE_FOLD = 50;
/** Rows rendered beyond the visible window, for smooth scrolling without a visible blank. */
export const VIRTUAL_OVERSCAN = 8;
/** A card's height for the virtualiser's first estimate; it measures the real one afterwards. */
export const CARD_ESTIMATE_PX = 128;
export const ROW_ESTIMATE_PX = 52;

/**
 * A stage's colour arrives as a semantic token name (`STAGE_COLOURS`); the design system speaks
 * in tones. This is the one map between the two vocabularies.
 */
export const STAGE_TONES: Record<StageColour, Tone> = {
    neutral: 'neutral',
    accent: 'accent',
    info: 'info',
    ok: 'success',
    warn: 'warning',
    bad: 'danger',
};

/** "3d", "21d" — the board's age label from the API's computed days. */
export function daysLabel(days: number): string {
    return `${days}d`;
}
