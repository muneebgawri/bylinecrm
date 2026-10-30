import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service';
import { GMAIL_QUOTA_KEY_PREFIX, GMAIL_QUOTA_UNITS_PER_S } from './mail-sync.constants';

/**
 * Keeps a mailbox's Gmail requests under `GMAIL_QUOTA_UNITS_PER_S`, across every worker process: a
 * fixed one-second window per mailbox in Redis. A request that would overrun the window waits for
 * the next one rather than being sent and throttled by Google. A request costing more than a whole
 * window (a send, 100 units) is let through alone in an otherwise empty second.
 */
@Injectable()
export class GmailQuota {
    constructor(private readonly redis: RedisService) {}

    async take(mailboxId: string, units: number): Promise<void> {
        await this.redis.ensureReady();
        for (;;) {
            const second = Math.floor(Date.now() / 1000);
            const key = `${GMAIL_QUOTA_KEY_PREFIX}${mailboxId}:${second}`;
            const used = await this.redis.incrby(key, units);
            if (used === units) await this.redis.expire(key, 2);
            if (used <= GMAIL_QUOTA_UNITS_PER_S || used === units) return;
            // Over the window: give the units back and wait for the next second.
            await this.redis.decrby(key, units);
            await new Promise((resolve) => setTimeout(resolve, (second + 1) * 1000 - Date.now()));
        }
    }
}
