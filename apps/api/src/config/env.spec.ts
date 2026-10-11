import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

/** The smallest environment that boots; each test adds the variable it is about. */
const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    RLS_DATABASE_URL: 'postgresql://a:p@127.0.0.1:5432/db',
    REDIS_URL: 'redis://127.0.0.1:6379',
    PORT: '3300',
    APP_URL: 'http://localhost:3300',
    WEB_URL: 'http://localhost:3301',
    SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('SIGNUP_MODE and PLATFORM_ADMIN_EMAILS (P0-14)', () => {
    it('sign-up is closed when the deployment says nothing', () => {
        expect(parseEnv(base).SIGNUP_MODE).toBe('closed');
    });

    it('takes the three modes and refuses to boot on anything else', () => {
        for (const mode of ['closed', 'invite', 'open'] as const) {
            expect(parseEnv({ ...base, SIGNUP_MODE: mode }).SIGNUP_MODE).toBe(mode);
        }
        expect(() => parseEnv({ ...base, SIGNUP_MODE: 'Open' })).toThrow(/SIGNUP_MODE/);
        expect(() => parseEnv({ ...base, SIGNUP_MODE: 'yes' })).toThrow(/SIGNUP_MODE/);
    });

    it('no platform admins is a valid state', () => {
        expect(parseEnv(base).PLATFORM_ADMIN_EMAILS).toEqual([]);
        expect(parseEnv({ ...base, PLATFORM_ADMIN_EMAILS: ' , ' }).PLATFORM_ADMIN_EMAILS).toEqual([]);
    });

    it('reads a comma list, lower-cased and de-duplicated, and refuses a non-address', () => {
        const env = parseEnv({
            ...base,
            PLATFORM_ADMIN_EMAILS: ' Matt@Example.com, ops@example.com ,matt@example.com',
        });
        expect(env.PLATFORM_ADMIN_EMAILS).toEqual(['matt@example.com', 'ops@example.com']);
        expect(() => parseEnv({ ...base, PLATFORM_ADMIN_EMAILS: 'matt@example.com, not-an-address' })).toThrow(
            /PLATFORM_ADMIN_EMAILS/,
        );
    });
});
