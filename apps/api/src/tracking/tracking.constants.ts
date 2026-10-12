/**
 * Every fixed number tracking (P3-4, FR-CRMS-8) runs on. Why each is what it is:
 * docs/design-notes/P3-4.md.
 */

/**
 * The public routes' brake: requests per client IP per window, across the redirect and the pixel.
 * A person clicks a few links; a security gateway fetching every link in a mailbox's worth of mail
 * from one address is what this stops from loading the database.
 */
export const TRACKING_RATE_LIMIT = 120;
export const TRACKING_RATE_WINDOW_S = 60;

/** The rate limiter's key for one client. */
export function trackingRateKey(ip: string): string {
    return `tracking:ip:${ip}`;
}

/** Bytes of randomness in a tracking token (256 bits; 43 base64url characters), like an unsubscribe token. */
export const TRACKING_TOKEN_BYTES = 32;

/** A 1×1 transparent GIF: the open pixel's whole body. */
export const TRACKING_PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
