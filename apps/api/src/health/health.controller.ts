import { Controller, Get } from '@nestjs/common';
import type { HealthStatus } from '@bylinecrm/shared';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
    constructor(private readonly health: HealthService) {}

    /** Always `200`: the body reports, the deployer decides. */
    @Get()
    get(): Promise<HealthStatus> {
        return this.health.check();
    }
}
