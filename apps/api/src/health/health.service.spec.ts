import { APP_DB_ROLE } from '@bylinecrm/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthService, PROBE_TIMEOUT_MS } from './health.service';
import type { PrismaService } from '../infra/prisma.service';
import type { RedisService } from '../infra/redis.service';
import type { RlsPrismaService } from '../infra/rls-prisma.service';
import { VERSION } from '../version';

const appRole = [{ current_user: APP_DB_ROLE, rolbypassrls: false }];

function service(
    opts: { db?: () => Promise<unknown>; rls?: () => Promise<unknown>; redis?: () => Promise<unknown> } = {},
): HealthService {
    const owner = { $queryRaw: opts.db ?? (() => Promise.resolve([{ '?column?': 1 }])) } as unknown as PrismaService;
    const rls = { $queryRaw: opts.rls ?? (() => Promise.resolve(appRole)) } as unknown as RlsPrismaService;
    const redis = {
        status: 'ready',
        connect: () => Promise.resolve(),
        ping: opts.redis ?? (() => Promise.resolve('PONG')),
    } as unknown as RedisService;
    return new HealthService(owner, rls, redis);
}

describe('HealthService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reports ok when both dependencies answer and RLS is in force', async () => {
        await expect(service().check()).resolves.toEqual({
            status: 'ok',
            db: 'ok',
            redis: 'ok',
            rls: 'ok',
            version: VERSION,
        });
    });

    it('reports the database down and the whole status degraded', async () => {
        const status = await service({ db: () => Promise.reject(new Error('ECONNREFUSED')) }).check();
        expect(status).toMatchObject({ status: 'degraded', db: 'down', redis: 'ok' });
    });

    it('reports redis down independently of the database', async () => {
        const status = await service({ redis: () => Promise.reject(new Error('closed')) }).check();
        expect(status).toMatchObject({ status: 'degraded', db: 'ok', redis: 'down' });
    });

    it('reports RLS misconfigured when the restricted client is the owner', async () => {
        const owner = () => Promise.resolve([{ current_user: 'bylinecrm', rolbypassrls: true }]);
        const status = await service({ rls: owner }).check();
        expect(status).toMatchObject({ status: 'degraded', db: 'ok', rls: 'misconfigured' });
    });

    it('reports RLS misconfigured when the app role can bypass RLS', async () => {
        const bypass = () => Promise.resolve([{ current_user: APP_DB_ROLE, rolbypassrls: true }]);
        await expect(service({ rls: bypass }).check()).resolves.toMatchObject({ rls: 'misconfigured' });
    });

    it('reports RLS misconfigured when the restricted client cannot answer', async () => {
        const down = () => Promise.reject(new Error('ECONNREFUSED'));
        await expect(service({ rls: down }).check()).resolves.toMatchObject({ rls: 'misconfigured' });
    });

    it('treats a probe that never answers as down after the timeout', async () => {
        const pending = service({ db: () => new Promise(() => undefined) }).check();
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
        await expect(pending).resolves.toMatchObject({ db: 'down', redis: 'ok' });
    });

    it('carries the package version', () => {
        expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });
});
