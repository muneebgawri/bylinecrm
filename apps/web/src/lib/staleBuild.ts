/**
 * A deploy replaces the hashed chunks under `/assets/`, so a tab opened before it asks for code that is no
 * longer there and the import fails. The cure is the new app shell: reload once. A second failure within a
 * minute is a real outage, not a stale tab, and is shown as an error rather than reloaded in a loop.
 */
const KEY = 'bylinecrm:stale-build-reload';
const WINDOW_MS = 60_000;

/** The browsers' words for a dynamic import that could not be fetched (Chromium, Firefox, Safari). */
const STALE =
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isStaleBuild(error: unknown): boolean {
    return error instanceof Error && STALE.test(error.message);
}

/** False when the page already reloaded for a new build a moment ago (or cannot remember that it did). */
export function mayReloadForNewBuild(): boolean {
    try {
        const last = Number(sessionStorage.getItem(KEY));
        return !last || Date.now() - last >= WINDOW_MS;
    } catch {
        return false;
    }
}

export function reloadForNewBuild(): void {
    try {
        sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
        return;
    }
    window.location.reload();
}
