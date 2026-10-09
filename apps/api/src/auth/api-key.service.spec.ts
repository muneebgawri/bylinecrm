import { API_KEY_ID_LENGTH, API_KEY_PREFIX } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { parseApiKey } from './api-key.service';
import { digestsEqual, hashToken, randomToken } from './tokens';

describe('parseApiKey', () => {
    const prefix = 'a'.repeat(API_KEY_ID_LENGTH);

    it('splits a well-formed key into prefix and secret', () => {
        expect(parseApiKey(`${API_KEY_PREFIX}_${prefix}_s3cr3t-Value_x`)).toEqual({ prefix, secret: 's3cr3t-Value_x' });
    });

    it.each([
        ['wrong product prefix', `xyz_${prefix}_secret`],
        ['prefix too short', `${API_KEY_PREFIX}_abc_secret`],
        ['missing secret', `${API_KEY_PREFIX}_${prefix}_`],
        ['characters outside the alphabet', `${API_KEY_PREFIX}_${prefix}_se cret`],
        ['a session token', randomToken()],
    ])('rejects %s', (_, presented) => {
        expect(parseApiKey(presented)).toBeNull();
    });
});

describe('tokens', () => {
    it('hashes deterministically and compares digests without throwing on length mismatch', () => {
        const token = randomToken();
        expect(hashToken(token)).toBe(hashToken(token));
        expect(digestsEqual(hashToken(token), hashToken(token))).toBe(true);
        expect(digestsEqual(hashToken(token), hashToken(randomToken()))).toBe(false);
        expect(digestsEqual(hashToken(token), 'ab')).toBe(false);
    });
});
