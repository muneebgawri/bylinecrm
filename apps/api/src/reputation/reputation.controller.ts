import { Body, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PausedMailboxView, ReputationSettingsView } from '@bylinecrm/shared';
import { Requires, TenantController } from '../auth/decorators';
import { Returns } from '../openapi/responses';
import { ResumeMailboxDto, UpdateReputationSettingsDto } from './dto';
import { ReputationService } from './reputation.service';
import { pausedMailboxList, reputationSettings } from './responses';

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

    /** REP-2: every paused mailbox — the reply-rate floor, the spam-rate kill switch, the pool's rates. */
    @Requires('guardrail:review')
    @Get('paused-mailboxes')
    @Returns(pausedMailboxList)
    paused(): Promise<PausedMailboxView[]> {
        return this.reputation.paused();
    }

    /** REP-2: a manager lifts a mailbox's pause, saying why (`409` when it is not paused). */
    @Requires('guardrail:review')
    @Post('paused-mailboxes/:mailboxId/resume')
    @Returns(pausedMailboxList)
    resume(
        @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
        @Body() body: ResumeMailboxDto,
    ): Promise<PausedMailboxView[]> {
        return this.reputation.resume(mailboxId, body.note);
    }
}
