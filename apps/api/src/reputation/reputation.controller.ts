import { Body, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ReputationSettingsView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { UpdateReputationSettingsDto } from './dto';
import { ReputationService } from './reputation.service';
import { reputationSettings } from './responses';

/** Sender-reputation thresholds (REP-1, FR-CRMS-23), on Settings → Guardrails. Defaults: docs/design-notes/REP-1.md. */
@ApiTags('reputation')
@TenantController('reputation')
export class ReputationController {
    constructor(private readonly reputation: ReputationService) {}

    @Requires('guardrail:review')
    @Get('settings')
    @Returns(reputationSettings)
    settings(): Promise<ReputationSettingsView> {
        return this.reputation.settings();
    }

    @Requires('workspace:admin')
    @Put('settings')
    @Returns(reputationSettings)
    updateSettings(@Body() body: UpdateReputationSettingsDto): Promise<ReputationSettingsView> {
        return this.reputation.updateSettings(body);
    }
}
