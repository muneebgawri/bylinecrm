/**
 * Theme and density are two attributes on `<html>`; `tokens.css` reads them. `system` means no
 * attribute, so the OS preference applies through the media query. The storage key is the single
 * place the persisted preference's name lives.
 */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const THEME_STORAGE_KEY = 'bylinecrm.theme';
export const DENSITY_STORAGE_KEY = 'bylinecrm.density';

export const THEME_ATTRIBUTE = 'data-theme';
export const DENSITY_ATTRIBUTE = 'data-density';

export function isTheme(value: unknown): value is Theme {
    return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function isDensity(value: unknown): value is Density {
    return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

/** Writes the attributes `tokens.css` reads. `system` and `comfortable` are the absence of an attribute. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
    if (theme === 'system') root.removeAttribute(THEME_ATTRIBUTE);
    else root.setAttribute(THEME_ATTRIBUTE, theme);
}

export function applyDensity(root: HTMLElement, density: Density): void {
    if (density === 'comfortable') root.removeAttribute(DENSITY_ATTRIBUTE);
    else root.setAttribute(DENSITY_ATTRIBUTE, density);
}
