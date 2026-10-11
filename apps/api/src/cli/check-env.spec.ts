import { describe, expect, it } from 'vitest';
import { checkEnv } from './check-env';

/** The smallest environment that boots outside production. */
const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
    RLS_DATABASE_URL: 'postgresql://a:p@127.0.0.1:5432/db',
    REDIS_URL: 'redis://127.0.0.1:6379',
    PORT: '3300',
    APP_URL: 'http://localhost:3300',
    WEB_URL: 'http://localhost:3301',
    SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'),
};

function run(source: NodeJS.ProcessEnv): { code: number; lines: string[] } {
    const lines: string[] = [];
    const code = checkEnv(source, (line) => lines.push(line));
    return { code, lines };
}

describe('#120 check-env: the release preflight refuses an environment the api would refuse', () => {
    it('passes an environment that boots, and says nothing', () => {
        expect(run(base)).toEqual({ code: 0, lines: [] });
    });

    it('fails a production environment missing MAIL_FROM, naming it — the 2026-10-11 staging outage', () => {
        const { code, lines } = run({
            ...base,
            NODE_ENV: 'production',
            RESEND_API_KEY: 're_test_key',
        });
        expect(code).toBe(1);
        expect(lines).toEqual(['MAIL_FROM: required when NODE_ENV=production (transactional mail, #93)']);
    });

    it('lists every problem, one line each, not just the first', () => {
        const { code, lines } = run({ ...base, NODE_ENV: 'production', SECRETS_KEY: '' });
        expect(code).toBe(1);
        expect(lines.map((line) => line.split(':')[0])).toEqual(
            expect.arrayContaining(['SECRETS_KEY', 'RESEND_API_KEY', 'MAIL_FROM']),
        );
        expect(lines).toHaveLength(3);
    });

    it('names variables, never values', () => {
        const secret = 'not-a-url-but-a-secret-value';
        const { code, lines } = run({ ...base, DATABASE_URL: secret });
        expect(code).toBe(1);
        expect(lines.join('\n')).toContain('DATABASE_URL');
        expect(lines.join('\n')).not.toContain(secret);
    });
});
