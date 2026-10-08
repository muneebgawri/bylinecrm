import { Injectable } from '@nestjs/common';
import type { DependencyState, HealthStatus } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { VERSION } from '../version';

/** A probe that has not answered by then is reported `down`; a hung socket must not hang `/health`. */
export const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly redis: RedisService,
    ) {}

    async check(): Promise<HealthStatus> {
        const [db, redis] = await Promise.all([
            probe(() => this.prisma.$queryRaw`SELECT 1`),
            probe(async () => {
                if (this.redis.status !== 'ready') await this.redis.connect();
                await this.redis.ping();
            }),
        ]);
        return { status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded', db, redis, version: VERSION };
    }
}

/** Runs one dependency probe; any rejection or a timeout is `down`. */
async function probe(run: () => Promise<unknown>): Promise<DependencyState> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
    });
    try {
        await Promise.race([run(), timeout]);
        return 'ok';
    } catch {
        // The reason is not reported: /health is unauthenticated and says only up or down.
        return 'down';
    } finally {
        clearTimeout(timer);
    }
}
