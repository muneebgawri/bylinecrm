import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

/**
 * The one Redis connection. Commands are not queued while disconnected, so a probe against a
 * down Redis fails instead of waiting for a reconnect that may never come.
 */
@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
    constructor(@Inject(ENV) env: Env) {
        super(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    }

    async onModuleDestroy(): Promise<void> {
        await this.quit();
    }
}
