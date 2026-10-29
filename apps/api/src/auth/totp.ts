import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second steps, six digits,
 * as every authenticator app expects. No dependency: the whole algorithm is forty lines, and the
 * RFC's own test vectors prove them (`totp.spec.ts`).
 */

export const TOTP_DIGITS = 6;
export const TOTP_STEP_S = 30;
/** Steps either side of now a code is accepted for: one, so a slow clock or a slow thumb still works. */
export const TOTP_WINDOW = 1;
/** Secret bytes: 160 bits, SHA-1's block, the size authenticator apps are tested with. */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the form an otpauth URL and a manual entry take. */
export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(text: string): Buffer {
    const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        value = (value << 5) | BASE32.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export function newTotpSecret(): string {
    return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The code for one counter value (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
    const message = Buffer.alloc(8);
    message.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
    message.writeUInt32BE(counter >>> 0, 4);
    const digest = createHmac('sha1', secret).update(message).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary =
        ((digest[offset]! & 0x7f) << 24) |
        (digest[offset + 1]! << 16) |
        (digest[offset + 2]! << 8) |
        digest[offset + 3]!;
    return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for a moment in time. */
export function totp(secretBase32: string, atMs = Date.now()): string {
    return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / TOTP_STEP_S));
}

/**
 * Whether `code` is the current code or one step either side, and which step it was — the caller
 * remembers the step so the same code cannot be spent twice inside its window.
 */
export function verifyTotp(
    secretBase32: string,
    code: string,
    atMs = Date.now(),
    window = TOTP_WINDOW,
): { ok: true; step: number } | { ok: false } {
    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) return { ok: false };
    const secret = base32Decode(secretBase32);
    const now = Math.floor(atMs / 1000 / TOTP_STEP_S);
    const given = Buffer.from(digits);
    for (let step = now - window; step <= now + window; step++) {
        const expected = Buffer.from(hotp(secret, step));
        if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true, step };
    }
    return { ok: false };
}

/** What an authenticator app scans: the account it is for, the issuer, and the secret. */
export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
    return `otpauth://totp/${label}?${params.toString()}`;
}
