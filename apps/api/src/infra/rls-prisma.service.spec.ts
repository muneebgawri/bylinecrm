import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env';
import { RLS_POOL_SIZE, RLS_POOL_TIMEOUT_S } from './rls-pool.constants';
import { RlsPrismaService, withPoolDefaults } from './rls-prisma.service';
import { WorkspaceContext } from './workspace-context';

describe('withPoolDefaults', () => {
    it('applies the pool size and timeout when the URL sets neither', () => {
        const url = new URL(withPoolDefaults('postgresql://u:p@h:5432/db'));
        expect(url.searchParams.get('connection_limit')).toBe(String(RLS_POOL_SIZE));
        expect(url.searchParams.get('pool_timeout')).toBe(String(RLS_POOL_TIMEOUT_S));
    });

    it("keeps an operator's explicit values", () => {
        const url = new URL(withPoolDefaults('postgresql://u:p@h:5432/db?connection_limit=3&pool_timeout=1'));
        expect(url.searchParams.get('connection_limit')).toBe('3');
        expect(url.searchParams.get('pool_timeout')).toBe('1');
    });

    it('leaves the credentials and database untouched', () => {
        const url = new URL(withPoolDefaults('postgresql://user:pa%40ss@host:5441/byline?schema=public'));
        expect(url.username).toBe('user');
        expect(url.password).toBe('pa%40ss');
        expect(url.pathname).toBe('/byline');
        expect(url.searchParams.get('schema')).toBe('public');
    });
});

describe('observeQueries (P1-4a)', () => {
    const env = (events: boolean) =>
        ({ RLS_DATABASE_URL: 'postgresql://bylinecrm_app:x@localhost:1/db', DB_QUERY_EVENTS: events }) as Env;

    it('throws when the client emits no query events, so a forgotten flag fails loudly', () => {
        const client = new RlsPrismaService(env(false), new WorkspaceContext());
        expect(() => client.observeQueries(() => undefined, { requestId: 'r' })).toThrow(/DB_QUERY_EVENTS=1/);
    });

    it('registers, and stops, when the flag is on', () => {
        const client = new RlsPrismaService(env(true), new WorkspaceContext());
        const stop = client.observeQueries(() => undefined, { requestId: 'r' });
        expect(typeof stop).toBe('function');
        stop();
    });
});
