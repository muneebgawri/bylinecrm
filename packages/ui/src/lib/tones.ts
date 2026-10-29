/**
 * A tone is a meaning, never a hue — the ONE definition shared by badges, icon tiles, avatars,
 * timeline markers and deltas:
 *   neutral  informational, no judgement (a tag, a count)
 *   accent   the product's own emphasis (selected, in progress by us, the purple)
 *   success  done, verified, healthy, paid, won
 *   warning  needs attention but nothing is broken (stale, warming, risky)
 *   danger   broken, refused, failed, paused by a rule
 *   info     scheduled, system-originated, a meeting
 * A component that needs a colour for a state picks the meaning here.
 */
export const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const;
export type Tone = (typeof TONES)[number];

/** Tinted surface with the tone's text on it: badges, icon tiles, avatars. */
export const toneSoft: Record<Tone, string> = {
    neutral: 'bg-surface-raised text-text-muted border border-border',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-info-soft text-info',
};

/** The tone's solid colour as a background, for dots and bars. */
export const toneSolid: Record<Tone, string> = {
    neutral: 'bg-text-faint',
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
};

/** The tone's gradient tile, for the icon box on a KPI card; the glyph on it is white. */
export const toneTile: Record<Tone, string> = {
    neutral: 'bg-tile-neutral text-white',
    accent: 'bg-tile-accent text-white',
    success: 'bg-tile-success text-white',
    warning: 'bg-tile-warning text-white',
    danger: 'bg-tile-danger text-white',
    info: 'bg-tile-info text-white',
};

/** The tone's colour as text. */
export const toneText: Record<Tone, string> = {
    neutral: 'text-text-muted',
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    info: 'text-info',
};
