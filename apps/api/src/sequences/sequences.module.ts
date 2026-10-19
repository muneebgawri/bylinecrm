import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { MailSendModule } from '../mail-send/mail-send.module';
import { RecordsModule } from '../records/records.module';
import { SendingPoolModule } from '../sending-pool/sending-pool.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { TemplatesModule } from '../templates/templates.module';
import { VerificationModule } from '../verification/verification.module';
import { EnrolmentScreen } from './enrolment-screen';
import { EnrolmentsService } from './enrolments.service';
import { ExclusionsService } from './exclusions.service';
import { RegionPolicyService } from './region-policy.service';
import { SequenceRunner } from './sequence-runner';
import { SequenceSweep } from './sequence-sweep';
import {
    EnrolmentsController,
    OutreachComplianceController,
    PersonEnrolmentsController,
    SequencesController,
} from './sequences.controllers';
import { SequencesConsumer } from './sequences.consumer';
import {
    SEQUENCE_MAINTENANCE_QUEUE,
    SEQUENCE_STEP_ATTEMPTS,
    SEQUENCE_STEP_BACKOFF_MS,
    SEQUENCE_STEP_QUEUE,
} from './sequences.constants';
import { SequencesService } from './sequences.service';
import { SequenceWorkers } from './sequences.workers';

/**
 * Sequences (P3-3, FR-CRMS-5, -10, -11, -12): the builder's backend, enrolment through one screen
 * (suppression is P3-1's check, the pool P3-2's, verification P3-5's), the step runner and its jobs, the sweep, and the
 * outbox consumer that reacts to sends, replies, suppressions, deals and deletions. A step's send is
 * scheduled through sending (`MailSendService.scheduleOutreach`) — one send path.
 */
@Module({
    imports: [
        AuthModule,
        GuardrailsModule,
        MailSendModule,
        RecordsModule,
        SendingPoolModule,
        SuppressionModule,
        TemplatesModule,
        VerificationModule,
        BullModule.registerQueue({
            name: SEQUENCE_STEP_QUEUE,
            defaultJobOptions: {
                attempts: SEQUENCE_STEP_ATTEMPTS,
                backoff: { type: 'exponential', delay: SEQUENCE_STEP_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
        BullModule.registerQueue({
            name: SEQUENCE_MAINTENANCE_QUEUE,
            defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
        }),
    ],
    controllers: [SequencesController, EnrolmentsController, PersonEnrolmentsController, OutreachComplianceController],
    providers: [
        SequencesService,
        EnrolmentsService,
        EnrolmentScreen,
        ExclusionsService,
        RegionPolicyService,
        SequenceRunner,
        SequenceSweep,
        SequencesConsumer,
        SequenceWorkers,
    ],
    // The Twenty importer (P4-4) writes a lead lookup as an exclusion through the one service.
    exports: [ExclusionsService],
})
export class SequencesModule {}
