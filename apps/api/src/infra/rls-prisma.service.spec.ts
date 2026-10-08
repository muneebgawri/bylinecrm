import { describe, expect, it } from 'vitest';
import { RLS_POOL_SIZE, RLS_POOL_TIMEOUT_S } from './rls-pool.constants';
import { withPoolDefaults } from './rls-prisma.service';

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
