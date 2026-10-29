import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUrl, totp, verifyTotp } from './totp';

/** RFC 6238 Appendix B: the SHA-1 secret is the ASCII digits 1–20; its eight-digit codes, trimmed to six. */
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);
const RFC_VECTORS: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
];

describe('totp', () => {
    it('base32 round-trips bytes and is what the RFC secret encodes to', () => {
        expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        expect(base32Decode(RFC_SECRET_B32)).toEqual(RFC_SECRET);
        expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_SECRET);
    });

    it('produces the RFC 6238 SHA-1 test vectors', () => {
        for (const [seconds, eight] of RFC_VECTORS) {
            expect(hotp(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(eight);
            expect(totp(RFC_SECRET_B32, seconds * 1000)).toBe(eight.slice(-6));
        }
    });

    it('accepts the current code and one step either side, and nothing further', () => {
        const at = 1111111111 * 1000;
        const step = Math.floor(1111111111 / 30);
        expect(verifyTotp(RFC_SECRET_B32, '050471', at)).toEqual({ ok: true, step });
        expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step - 1), at)).toEqual({ ok: true, step: step - 1 });
        expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step + 1), at)).toEqual({ ok: true, step: step + 1 });
        expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step + 2), at)).toEqual({ ok: false });
        expect(verifyTotp(RFC_SECRET_B32, '05047', at)).toEqual({ ok: false });
        expect(verifyTotp(RFC_SECRET_B32, 'abcdef', at)).toEqual({ ok: false });
    });

    it('writes an otpauth URL an authenticator app scans', () => {
        expect(otpauthUrl('BylineCRM', 'kate@example.com', 'ABC234')).toBe(
            'otpauth://totp/BylineCRM%3Akate%40example.com?secret=ABC234&issuer=BylineCRM&algorithm=SHA1&digits=6&period=30',
        );
    });
});
