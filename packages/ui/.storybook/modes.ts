import type { Density, Theme } from '../src/theme/theme';

/**
 * A story renders in one mode: the decorator in preview.tsx reads `parameters.mode` and sets the
 * same `<html>` attributes the app sets, through the same functions. A component's gallery is
 * exported once per mode so the a11y and visual gates cover light, dark and compact without
 * each story file repeating the list.
 */
export interface Mode {
    theme: Theme;
    density: Density;
}

export const MODES = {
    light: { theme: 'light', density: 'comfortable' },
    dark: { theme: 'dark', density: 'comfortable' },
    compact: { theme: 'light', density: 'compact' },
} as const satisfies Record<string, Mode>;

export type ModeName = keyof typeof MODES;

/** Structural, not Storybook's own generic, so it accepts a story typed against any meta. */
export function inMode<S extends { parameters?: Record<string, unknown> }>(story: S, mode: ModeName): S {
    return { ...story, parameters: { ...story.parameters, mode } };
}
