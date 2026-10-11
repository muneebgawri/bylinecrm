/**
 * The public unsubscribe routes' brake (P3-1): requests per client IP per window, across all three
 * routes. A mail client makes one POST per click; the page makes one status read and one POST. The
 * limit is far above that and far below what guessing a 256-bit token would need anyway — it is there
 * so the routes cannot be used to load the database.
 */
export const UNSUBSCRIBE_RATE_LIMIT = 30;
export const UNSUBSCRIBE_RATE_WINDOW_S = 60;

/** The rate limiter's key for one client. */
export function unsubscribeRateKey(ip: string): string {
    return `unsubscribe:ip:${ip}`;
}

/** Bytes of randomness in an unsubscribe token (256 bits; 43 base64url characters). */
export const UNSUBSCRIBE_TOKEN_BYTES = 32;
