import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env';
import { SecretBox } from './secret-box';

function boxWith(key: Buffer): SecretBox {
    return new SecretBox({ SECRETS_KEY: key } as unknown as Env);
}

describe('SecretBox', () => {
    const key = randomBytes(32);

    it('opens what it sealed, and seals the same text differently each time', () => {
        const box = boxWith(key);
        const a = box.seal('whsec_example');
        const b = box.seal('whsec_example');
        expect(a).not.toBe(b);
        expect(box.open(a)).toBe('whsec_example');
        expect(box.open(b)).toBe('whsec_example');
        expect(a.startsWith('v1.')).toBe(true);
    });

    it('refuses a value sealed with another key, or tampered with', () => {
        const sealed = boxWith(key).seal('secret');
        expect(() => boxWith(randomBytes(32)).open(sealed)).toThrow();
        const [v, n, c, t] = sealed.split('.');
        const flipped = Buffer.from(c!, 'base64url');
        flipped[0] = flipped[0]! ^ 0xff;
        expect(() => boxWith(key).open([v, n, flipped.toString('base64url'), t].join('.'))).toThrow();
        expect(() => boxWith(key).open('v0.a.b.c')).toThrow();
    });
});
