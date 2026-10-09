import type { HealthStatus } from '@bylinecrm/shared';
import { z } from 'zod';
import { named } from '../openapi/responses';

const dependency = z.enum(['ok', 'down']);

/** `/health`: always `200`; the body reports and the deployer decides. */
export const healthStatus: z.ZodType<HealthStatus> = named(
    'HealthStatus',
    z.object({
        status: z.enum(['ok', 'degraded']),
        db: dependency,
        redis: dependency,
        rls: z.enum(['ok', 'misconfigured']),
        version: z.string(),
    }),
);
