/**
 * Sends the browser to another site (Google's consent screen). The one place the app leaves
 * itself: a full navigation, not the router, because the destination is not ours. A module of
 * its own so a test can stand in for it — jsdom does not navigate.
 */
export function leaveFor(url: string): void {
    window.location.assign(url);
}
