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

    /**
     * Resolves once the connection is usable, connecting a lazy client on first use. Safe to call
     * from concurrent callers: a client already connecting is waited for, never connected twice.
     */
    async ensureReady(): Promise<void> {
        if (this.status === 'ready') return;
        if (this.status === 'wait') {
            await this.connect();
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const onReady = (): void => {
                this.off('error', onError);
                resolve();
            };
            const onError = (error: Error): void => {
                this.off('ready', onReady);
                reject(error);
            };
            this.once('ready', onReady);
            this.once('error', onError);
        });
    }

    /** A lazy client that never connected (`wait`) or already ended has nothing to quit. */
    async onModuleDestroy(): Promise<void> {
        if (this.status === 'wait' || this.status === 'end') return;
        await this.quit();
    }
}
