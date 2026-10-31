import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service';
import {
    GMAIL_DAY_KEY_PREFIX,
    GMAIL_DAY_KEY_TTL_S,
    GMAIL_QUOTA_DAY_ZONE,
    GMAIL_QUOTA_KEY_PREFIX,
    GMAIL_QUOTA_UNITS_PER_S,
} from './mail-sync.constants';

const quotaDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: GMAIL_QUOTA_DAY_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** Google's quota day for an instant, `YYYY-MM-DD` on the Pacific calendar. */
export function gmailQuotaDay(at: Date): string {
    return quotaDay.format(at);
}

/**
 * Keeps a mailbox's Gmail requests under `GMAIL_QUOTA_UNITS_PER_S`, across every worker process: a
 * fixed one-second window per mailbox in Redis. A request that would overrun the window waits for
 * the next one rather than being sent and throttled by Google. A request costing more than a whole
 * window (a send, 100 units) is let through alone in an otherwise empty second.
 *
 * Every request granted is also added to the project's total for Google's quota day (PNW-1194): the
 * one place every Gmail request is charged, so the day's spend needs no second meter.
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
            if (used <= GMAIL_QUOTA_UNITS_PER_S || used === units) {
                await this.countForDay(units);
                return;
            }
            // Over the window: give the units back and wait for the next second.
            await this.redis.decrby(key, units);
            await new Promise((resolve) => setTimeout(resolve, (second + 1) * 1000 - Date.now()));
        }
    }

    /** The project's units granted on a quota day (`gmailQuotaDay`); 0 for a day with none. */
    async dailyUnits(day: string): Promise<number> {
        await this.redis.ensureReady();
        return Number((await this.redis.get(`${GMAIL_DAY_KEY_PREFIX}${day}`)) ?? 0);
    }

    private async countForDay(units: number): Promise<void> {
        const key = `${GMAIL_DAY_KEY_PREFIX}${gmailQuotaDay(new Date())}`;
        if ((await this.redis.incrby(key, units)) === units) await this.redis.expire(key, GMAIL_DAY_KEY_TTL_S);
    }
}
