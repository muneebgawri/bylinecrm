import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimiter } from '../auth/rate-limiter.service';
import { RateLimited } from '../infra/errors/api-errors';
import { UNSUBSCRIBE_RATE_LIMIT, UNSUBSCRIBE_RATE_WINDOW_S, unsubscribeRateKey } from './suppression.constants';

/** The public unsubscribe routes' brake: `UNSUBSCRIBE_RATE_LIMIT` requests per client IP per window. */
@Injectable()
export class UnsubscribeRateGuard implements CanActivate {
    constructor(private readonly limiter: RateLimiter) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest<Request>();
        const over = await this.limiter.hit(
            unsubscribeRateKey(req.ip ?? ''),
            UNSUBSCRIBE_RATE_LIMIT,
            UNSUBSCRIBE_RATE_WINDOW_S,
        );
        if (over) throw new RateLimited('too many requests; try again in a minute');
        return true;
    }
}
