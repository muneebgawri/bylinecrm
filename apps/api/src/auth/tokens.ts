import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_BYTES } from './auth.constants';

/** A fresh opaque secret: session token, API-key secret, invite token. */
export function randomToken(bytes = TOKEN_BYTES): string {
    return randomBytes(bytes).toString('base64url');
}

/** What the database stores for any secret: its SHA-256, hex. The secret itself is never written. */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/** Compares two hex digests without leaking where they differ. */
export function digestsEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
