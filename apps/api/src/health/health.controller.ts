import { Controller, Get } from '@nestjs/common';
import type { HealthStatus } from '@bylinecrm/shared';
import { Public } from '../auth/decorators';
import { HealthService } from './health.service';
import { Returns } from '../openapi/responses';
import { healthStatus } from './responses';

/** Unauthenticated by design: the deployer's probe has no session, and the body says only up or down. */
@Public()
@Controller('health')
export class HealthController {
    constructor(private readonly health: HealthService) {}

    /** Always `200`: the body reports, the deployer decides. */
    @Get()
    @Returns(healthStatus)
    get(): Promise<HealthStatus> {
        return this.health.check();
    }
}
