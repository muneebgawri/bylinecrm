import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReputationController } from './reputation.controller';
import { ReputationGate } from './reputation-gate';
import { ReputationMonitor } from './reputation-monitor';
import { ReputationService } from './reputation.service';

/**
 * Sender reputation (REP-1, FR-CRMS-23): the gate a personal mailbox's new mail passes before it leaves
 * (`ReputationGate`, asked by sending and enrolment), the Gmail-side monitor sync runs after each mailbox's
 * sync (`ReputationMonitor`), and the thresholds' routes. Events go to `guardrail_events` (GUARD-1's table).
 */
@Module({
    imports: [AuthModule],
    controllers: [ReputationController],
    providers: [ReputationService, ReputationGate, ReputationMonitor],
    exports: [ReputationGate, ReputationMonitor],
})
export class ReputationModule {}
