/**
 * The floating surface shared by menus, selects and the command palette: one shape, one shadow,
 * one border. No enter/exit motion in v1 — surfaces appear, Linear-style — which also keeps
 * screenshots deterministic. Dialog is a surface of its own (centred, larger radius).
 */
export const popoverSurface =
    'z-50 overflow-hidden rounded-md border border-border bg-surface-raised text-text shadow-md';
