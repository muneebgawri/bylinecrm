/**
 * Values that satisfy the environment schema when the application is only being *compiled* —
 * to walk its router or write its OpenAPI document — and never connected. Ports of 1 and
 * hosts that answer nothing make sure of the second half: a code path that did try to connect
 * would fail loudly. Set only where nothing is set, so a real environment wins.
 */
export const PLACEHOLDER_ENV = {
    DATABASE_URL: 'postgresql://owner:x@localhost:1/db',
    RLS_DATABASE_URL: 'postgresql://bylinecrm_app:x@localhost:1/db',
    REDIS_URL: 'redis://localhost:1',
    PORT: '1',
    APP_URL: 'http://localhost:1',
    WEB_URL: 'http://localhost:2',
} as const;

export function applyPlaceholderEnv(): void {
    for (const [name, value] of Object.entries(PLACEHOLDER_ENV)) process.env[name] ??= value;
}

/**
 * How long a spec may take to create the whole application in-process (the router walk, the
 * contract snapshot). Measured at ~2.5 s on a quiet machine; the headroom is for a two-core CI
 * runner with another suite's workers alongside. One number, used by every such spec.
 */
export const APP_COMPILE_TIMEOUT_MS = 60_000;
