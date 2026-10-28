import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailSendModule } from '../mail-send/mail-send.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { TrackingModule } from '../tracking/tracking.module';
import { PoolSmtpHookController, PoolSmtpMailboxesController } from './smtp2go.controllers';
import { Smtp2GoHookService } from './smtp2go-hook.service';
import { Smtp2GoMailboxesService } from './smtp2go-mailboxes.service';
import { Smtp2GoTransportModule } from './smtp2go-transport.module';

/**
 * SMTP2Go as the outreach pool's second transport (TRANS-1, docs/design-notes/TRANS-1.md): its pool mailboxes
 * (an admin's) and its webhook. The send job's port is `Smtp2GoTransportModule`'s.
 */
@Module({
    imports: [AuthModule, MailSendModule, SuppressionModule, TrackingModule, Smtp2GoTransportModule],
    controllers: [PoolSmtpMailboxesController, PoolSmtpHookController],
    providers: [Smtp2GoMailboxesService, Smtp2GoHookService],
})
export class Smtp2GoModule {}
