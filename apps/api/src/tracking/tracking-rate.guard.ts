import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimiter } from '../auth/rate-limiter.service';
import { RateLimited } from '../infra/errors/api-errors';
import { TRACKING_RATE_LIMIT, TRACKING_RATE_WINDOW_S, trackingRateKey } from './tracking.constants';

/** The public tracking routes' brake: `TRACKING_RATE_LIMIT` requests per client IP per window. */
@Injectable()
export class TrackingRateGuard implements CanActivate {
    constructor(private readonly limiter: RateLimiter) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req = ctx.switchToHttp().getRequest<Request>();
        const over = await this.limiter.hit(trackingRateKey(req.ip ?? ''), TRACKING_RATE_LIMIT, TRACKING_RATE_WINDOW_S);
        if (over) throw new RateLimited('too many requests; try again in a minute');
        return true;
    }
}
