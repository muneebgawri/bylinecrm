import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthService, PROBE_TIMEOUT_MS } from './health.service';
import type { PrismaService } from '../infra/prisma.service';
import type { RedisService } from '../infra/redis.service';
import { VERSION } from '../version';

function service(opts: { db?: () => Promise<unknown>; redis?: () => Promise<unknown> } = {}): HealthService {
    const prisma = { $queryRaw: opts.db ?? (() => Promise.resolve([{ '?column?': 1 }])) } as unknown as PrismaService;
    const redis = {
        status: 'ready',
        connect: () => Promise.resolve(),
        ping: opts.redis ?? (() => Promise.resolve('PONG')),
    } as unknown as RedisService;
    return new HealthService(prisma, redis);
}

describe('HealthService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reports ok when both dependencies answer', async () => {
        await expect(service().check()).resolves.toEqual({ status: 'ok', db: 'ok', redis: 'ok', version: VERSION });
    });

    it('reports the database down and the whole status degraded', async () => {
        const status = await service({ db: () => Promise.reject(new Error('ECONNREFUSED')) }).check();
        expect(status).toMatchObject({ status: 'degraded', db: 'down', redis: 'ok' });
    });

    it('reports redis down independently of the database', async () => {
        const status = await service({ redis: () => Promise.reject(new Error('closed')) }).check();
        expect(status).toMatchObject({ status: 'degraded', db: 'ok', redis: 'down' });
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
