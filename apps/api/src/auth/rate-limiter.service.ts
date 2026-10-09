import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service';

/**
 * A fixed-window counter in Redis. `hit` counts one attempt and says whether the caller is now
 * over the limit; `clear` forgets a key (a successful login forgets its failures). If Redis is
 * unreachable the limiter fails closed — a login path with no brake is worse than a login path
 * that is briefly unavailable.
 */
@Injectable()
export class RateLimiter {
    constructor(private readonly redis: RedisService) {}

    async hit(key: string, max: number, windowS: number): Promise<boolean> {
        if (this.redis.status !== 'ready') await this.redis.connect();
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, windowS);
        return count > max;
    }

    async clear(key: string): Promise<void> {
        if (this.redis.status !== 'ready') await this.redis.connect();
        await this.redis.del(key);
    }
}
